import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/phase3_models.dart';
import '../../core/socket_service.dart';

/// In-app chat (PRD p.11): text + quick replies, read via socket
/// chat.message with REST fallback. Contact-sharing is flagged by the
/// backend moderation result — a warning is shown, never silently hidden.
class ChatScreen extends ConsumerStatefulWidget {
  const ChatScreen(
      {super.key, required this.chatId, this.peerName = 'Provider', this.peerId});

  final String chatId;
  final String peerName;

  /// The other party's id for block/report (provider profile id where
  /// known). Null when the chat was opened from a job screen, which
  /// does not carry the peer's id — block/report are then disabled
  /// rather than sent against the wrong id.
  final String? peerId;

  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen> {
  final _controller = TextEditingController();
  final _scroll = ScrollController();
  List<ChatMessage> _messages = [];
  bool _loading = true;
  TranslationPref? _pref;
  static const String _myId = 'me'; // replaced by real user id from /me in app state

  static const _quickReplies = [
    'I am on my way',
    'Need more info',
    'Running 10 minutes late',
    'Please share your location',
  ];

  @override
  void initState() {
    super.initState();
    _load();
    final socket = ref.read(socketServiceProvider);
    socket.connect();
    socket.joinRoom('job:${widget.chatId}');
    socket.on('chat.message', (data) {
      if (data is Map<String, dynamic> && mounted) {
        setState(() {
          _messages.add(ChatMessage.fromJson(data, _myId));
        });
        _scrollToBottom();
      }
    });
  }

  Future<void> _load() async {
    try {
      _messages = await ref.read(apiClientProvider).getMessages(widget.chatId, _myId);
    } catch (_) {
      _messages = []; // offline: empty chat, send queues on reconnect via socket
    }
    // Phase 3 — translation preference (best effort; chat works without it).
    try {
      _pref = await ref.read(apiClientProvider).getTranslationPref(widget.chatId);
    } catch (_) {
      _pref = null;
    }
    if (mounted) {
      setState(() => _loading = false);
      _scrollToBottom();
    }
  }

  /// Phase 3 — translation toggle (PUT /ai/chats/:id/translation).
  /// Auto-translate needs a target language; turning it off keeps the
  /// original text. Translations are dictionary-based on the local
  /// provider — the original message is always preserved.
  Future<void> _translationDialog() async {
    String? target = _pref?.targetLang;
    var auto = _pref?.autoTranslate ?? false;
    final save = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Chat translation'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Translate incoming messages to:'),
              const SizedBox(height: 8),
              DropdownButton<String?>(
                value: target,
                isExpanded: true,
                items: const [
                  DropdownMenuItem(value: null, child: Text('Off')),
                  DropdownMenuItem(value: 'ur', child: Text('Urdu')),
                  DropdownMenuItem(value: 'en', child: Text('English')),
                ],
                onChanged: (v) => setDialogState(() => target = v),
              ),
              SwitchListTile(
                title: const Text('Auto-translate'),
                value: auto,
                onChanged: target == null
                    ? null
                    : (v) => setDialogState(() => auto = v),
              ),
              const Text(
                'Auto-translate needs a target language. The original text is always kept.',
                style: TextStyle(fontSize: 12, color: Colors.grey),
              ),
            ],
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text('Cancel')),
            TextButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text('Save')),
          ],
        ),
      ),
    );
    if (save != true || !mounted) return;
    try {
      _pref = await ref.read(apiClientProvider).setTranslationPref(
            widget.chatId,
            targetLang: target,
            autoTranslate: target != null && auto,
          );
      if (mounted) {
        setState(() {});
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content: Text(target == null
                  ? 'Translation off.'
                  : 'Translating to ${target == 'ur' ? 'Urdu' : 'English'}${auto ? ' (auto)' : ''}.')),
        );
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message)),
        );
      }
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  /// FIX 10 — block the peer (POST /blocks). Only available when
  /// [ChatScreen.peerId] is set; see the note on that field.
  Future<void> _blockPeer() async {
    final peerId = widget.peerId;
    if (peerId == null) return;
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Block ${widget.peerName}?'),
        content: const Text(
            'Blocking is immediate and mutual: you will not see each other’s requests, offers or chats any more.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Block', style: TextStyle(color: Colors.red))),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await ref.read(apiClientProvider).createBlock(peerId);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('${widget.peerName} blocked.')),
        );
        Navigator.pop(context);
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.userMessage)));
      }
    }
  }

  /// FIX 10 — report the peer or this chat (POST /reports). Falls back
  /// to reporting the chat itself when the peer id is unknown, so a
  /// report is always possible from chat even when blocking is not.
  Future<void> _reportPeer() async {
    final reason = await showDialog<String>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('Report'),
        children: [
          for (final r in ['spam', 'fraud', 'abuse', 'off_platform', 'other'])
            SimpleDialogOption(
              onPressed: () => Navigator.pop(ctx, r),
              child: Text(r),
            ),
        ],
      ),
    );
    if (reason == null) return;
    try {
      await ref.read(apiClientProvider).reportUser(
            targetId: widget.peerId ?? widget.chatId,
            targetType: widget.peerId != null ? 'user' : 'message',
            reasonCode: reason,
            description: 'Reported from chat ${widget.chatId}',
          );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
              content: Text('Report sent — support will review it.')),
        );
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.userMessage)));
      }
    }
  }

  Future<void> _send(String text) async {    final body = text.trim();
    if (body.isEmpty) return;
    _controller.clear();
    // Optimistic local echo.
    setState(() {
      _messages.add(ChatMessage(
        id: 'local-${DateTime.now().millisecondsSinceEpoch}',
        chatId: widget.chatId,
        senderId: _myId,
        body: body,
        createdAt: DateTime.now(),
        isMine: true,
      ));
    });
    _scrollToBottom();
    try {
      await ref.read(apiClientProvider).sendMessage(widget.chatId, body, _myId);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Message will send when you are back online.')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.peerName),
        actions: [
          // FIX 10 — block / report the other party (POST /blocks,
          // POST /reports). Disabled when the peer id is unknown so a
          // block is never sent against a chat/job id by mistake.
          PopupMenuButton<String>(
            tooltip: 'More',
            onSelected: (v) {
              if (v == 'block') _blockPeer();
              if (v == 'report') _reportPeer();
              if (v == 'translate') _translationDialog();
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'report', child: Text('Report')),
              PopupMenuItem(
                value: 'translate',
                child: Text(_pref?.targetLang == null
                    ? 'Translate…'
                    : 'Translate: ${_pref!.targetLang == 'ur' ? 'Urdu' : 'English'}${_pref!.autoTranslate ? ' (auto)' : ''}'),
              ),
              PopupMenuItem(
                value: 'block',
                enabled: widget.peerId != null,
                child: Text('Block ${widget.peerName}',
                    style: const TextStyle(color: Colors.red)),
              ),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            color: scheme.surfaceContainerHighest,
            child: const Text(
              'Stay in the app: off-platform contact sharing loses payment protection and dispute support.',
              style: TextStyle(fontSize: 12, color: Colors.grey),
            ),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _messages.isEmpty
                    ? const Center(child: Text('No messages yet. Say hello!'))
                    : ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.all(16),
                        itemCount: _messages.length,
                        itemBuilder: (_, i) {
                          final m = _messages[i];
                          return Align(
                            alignment: m.isMine ? Alignment.centerRight : Alignment.centerLeft,
                            child: Container(
                              margin: const EdgeInsets.only(bottom: 8),
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                              constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.75),
                              decoration: BoxDecoration(
                                color: m.isMine ? const Color(0xFF0F766E) : scheme.surfaceContainerHighest,
                                borderRadius: BorderRadius.circular(16),
                              ),
                              child: Text(m.body,
                                  style: TextStyle(color: m.isMine ? Colors.white : null)),
                            ),
                          );
                        },
                      ),
          ),
          SizedBox(
            height: 44,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              itemCount: _quickReplies.length,
              separatorBuilder: (_, __) => const SizedBox(width: 8),
              itemBuilder: (_, i) => ActionChip(
                label: Text(_quickReplies[i]),
                onPressed: () => _send(_quickReplies[i]),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _controller,
                    decoration: const InputDecoration(hintText: 'Type a message…'),
                    onSubmitted: _send,
                    onChanged: (_) => ref.read(socketServiceProvider).sendTyping(widget.chatId),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  icon: const Icon(Icons.send, color: Color(0xFF0F766E)),
                  onPressed: () => _send(_controller.text),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
