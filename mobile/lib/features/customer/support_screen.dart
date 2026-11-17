import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../common/widgets.dart';

/// Live Support (Batch 2): list my support threads, start a new one
/// (subject + first message), and chat inside a thread.
/// Messages are polled every 15 s (there is no support socket room);
/// the open-ticket state is shown plainly ("Support will reply soon")
/// and an agent reply is NEVER faked — only messages the server
/// returns are shown.
class SupportScreen extends ConsumerStatefulWidget {
  const SupportScreen({super.key});

  @override
  ConsumerState<SupportScreen> createState() => _SupportScreenState();
}

class _SupportScreenState extends ConsumerState<SupportScreen> {
  List<SupportThread> _threads = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final threads = await ref.read(apiClientProvider).listSupportThreads();
      if (mounted) {
        setState(() {
          _threads = threads;
          _loading = false;
        });
      }
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.userMessage;
          _loading = false;
        });
      }
    }
  }

  Future<void> _newThread() async {
    final subjectCtrl = TextEditingController();
    final messageCtrl = TextEditingController();
    final created = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          top: 20,
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('New support ticket',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 16),
            TextField(
              controller: subjectCtrl,
              decoration: const InputDecoration(
                  labelText: 'Subject', hintText: 'e.g. Payment issue'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: messageCtrl,
              maxLines: 4,
              decoration: const InputDecoration(
                  labelText: 'What happened?',
                  hintText: 'Describe the problem…'),
            ),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: () {
                  if (subjectCtrl.text.trim().isEmpty ||
                      messageCtrl.text.trim().isEmpty) {
                    ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(
                        content: Text('Please add a subject and a message.')));
                    return;
                  }
                  Navigator.pop(ctx, true);
                },
                child: const Text('Send to support'),
              ),
            ),
          ],
        ),
      ),
    );
    if (created != true || !mounted) return;
    try {
      final thread = await ref.read(apiClientProvider).createSupportThread(
            subject: subjectCtrl.text.trim(),
            message: messageCtrl.text.trim(),
          );
      if (mounted) {
        await context.push('/customer/support/${thread.id}',
            extra: {'subject': thread.subject});
        _load();
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.userMessage)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Live Support')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _newThread,
        icon: const Icon(Icons.add, color: Colors.white),
        label: const Text('New ticket',
            style: TextStyle(color: Colors.white)),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null && _threads.isEmpty
              ? ErrorState(message: _error!, onRetry: _load)
              : _threads.isEmpty
                  ? EmptyState(
                      icon: Icons.headset_mic_outlined,
                      message:
                          'No support tickets yet. Tell us what went wrong and support will reply here.',
                      action: ElevatedButton(
                        onPressed: _newThread,
                        child: const Text('Start a ticket'),
                      ),
                    )
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.separated(
                        padding: const EdgeInsets.all(16),
                        itemCount: _threads.length,
                        separatorBuilder: (_, __) =>
                            const SizedBox(height: 12),
                        itemBuilder: (_, i) {
                          final t = _threads[i];
                          return Card(
                            child: ListTile(
                              leading: Icon(
                                t.isOpen
                                    ? Icons.mark_email_unread_outlined
                                    : Icons.mark_email_read_outlined,
                                color: t.isOpen
                                    ? const Color(0xFFD97706)
                                    : Colors.grey,
                              ),
                              title: Text(t.subject.isNotEmpty
                                  ? t.subject
                                  : 'Support ticket'),
                              subtitle: Text(t.isOpen
                                  ? 'Open — Support will reply soon'
                                  : 'Status: ${t.status.replaceAll('_', ' ')}'),
                              trailing: const Icon(Icons.chevron_right),
                              onTap: () async {
                                await context.push(
                                    '/customer/support/${t.id}',
                                    extra: {'subject': t.subject});
                                _load();
                              },
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}

/// One support thread: message history + reply box, polled every 15 s.
/// No fake agent replies — only server messages are rendered, with
/// the sender (you / support) shown on each bubble.
class SupportThreadScreen extends ConsumerStatefulWidget {
  const SupportThreadScreen(
      {super.key, required this.threadId, this.subject});

  final String threadId;
  final String? subject;

  @override
  ConsumerState<SupportThreadScreen> createState() =>
      _SupportThreadScreenState();
}

class _SupportThreadScreenState extends ConsumerState<SupportThreadScreen> {
  final _controller = TextEditingController();
  final _scroll = ScrollController();
  List<SupportMessage> _messages = [];
  bool _loading = true;
  bool _sending = false;
  String? _error;
  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    _load();
    _pollTimer = Timer.periodic(
        const Duration(seconds: 15), (_) => _load(silent: true));
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _controller.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) setState(() => _loading = true);
    try {
      final messages = await ref
          .read(apiClientProvider)
          .getSupportMessages(widget.threadId);
      if (!mounted) return;
      setState(() {
        _messages = messages;
        _loading = false;
        _error = null;
      });
      _scrollToBottom();
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.userMessage;
          _loading = false;
        });
      }
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOut);
      }
    });
  }

  Future<void> _send() async {
    final body = _controller.text.trim();
    if (body.isEmpty || _sending) return;
    _controller.clear();
    setState(() => _sending = true);
    // Optimistic local echo, marked as mine.
    setState(() {
      _messages.add(SupportMessage(
        id: 'local-${DateTime.now().millisecondsSinceEpoch}',
        senderRole: 'customer',
        body: body,
        createdAt: DateTime.now(),
      ));
    });
    _scrollToBottom();
    try {
      await ref
          .read(apiClientProvider)
          .sendSupportMessage(widget.threadId, body);
      await _load(silent: true);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.userMessage)));
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
          title: Text(widget.subject?.isNotEmpty == true
              ? widget.subject!
              : 'Support ticket')),
      body: Column(
        children: [
          Container(
            width: double.infinity,
            padding:
                const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            color: scheme.surfaceContainerHighest,
            child: const Text(
              'Open ticket — Support will reply soon. Replies appear here; no reply is shown until support actually sends one.',
              style: TextStyle(fontSize: 12),
            ),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null && _messages.isEmpty
                    ? ErrorState(message: _error!, onRetry: _load)
                    : _messages.isEmpty
                        ? const Center(
                            child: Text(
                                'No messages yet. Write your first message below.'))
                        : ListView.builder(
                            controller: _scroll,
                            padding: const EdgeInsets.all(16),
                            itemCount: _messages.length,
                            itemBuilder: (_, i) {
                              final m = _messages[i];
                              final mine = !m.isFromSupport;
                              return Align(
                                alignment: mine
                                    ? Alignment.centerRight
                                    : Alignment.centerLeft,
                                child: Container(
                                  margin:
                                      const EdgeInsets.only(bottom: 8),
                                  padding: const EdgeInsets.symmetric(
                                      horizontal: 14, vertical: 10),
                                  constraints: BoxConstraints(
                                      maxWidth:
                                          MediaQuery.of(context).size.width *
                                              0.75),
                                  decoration: BoxDecoration(
                                    color: mine
                                        ? const Color(0xFF0F766E)
                                        : scheme.surfaceContainerHighest,
                                    borderRadius: BorderRadius.circular(16),
                                  ),
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      if (!mine)
                                        const Text('Support',
                                            style: TextStyle(
                                                fontSize: 11,
                                                fontWeight: FontWeight.w700,
                                                color: Color(0xFFD97706))),
                                      Text(m.body,
                                          style: TextStyle(
                                              color: mine
                                                  ? Colors.white
                                                  : null)),
                                    ],
                                  ),
                                ),
                              );
                            },
                          ),
          ),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _controller,
                    decoration: const InputDecoration(
                        hintText: 'Write to support…'),
                    onSubmitted: (_) => _send(),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  icon: const Icon(Icons.send, color: Color(0xFF0F766E)),
                  onPressed: _sending ? null : _send,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
