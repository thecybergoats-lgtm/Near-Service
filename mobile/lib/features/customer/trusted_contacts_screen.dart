import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/models.dart';

/// Trusted contacts (FIX 10): list / add / remove, max 5 per user
/// (GET/POST/DELETE /me/trusted-contacts). SOS shares the live
/// location with these contacts, so the SOS flow gates on this list
/// being non-empty (see JobTrackingScreen._sos).
class TrustedContactsScreen extends ConsumerStatefulWidget {
  const TrustedContactsScreen({super.key});

  @override
  ConsumerState<TrustedContactsScreen> createState() =>
      _TrustedContactsScreenState();
}

class _TrustedContactsScreenState
    extends ConsumerState<TrustedContactsScreen> {
  List<TrustedContact> _contacts = [];
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
      _contacts = await ref.read(apiClientProvider).listTrustedContacts();
    } on ApiException catch (e) {
      _error = e.userMessage;
    } catch (_) {
      _error = 'Could not load trusted contacts. Check your connection.';
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _add() async {
    if (_contacts.length >= 5) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('You can add at most 5 trusted contacts.')),
      );
      return;
    }
    final created = await showModalBottomSheet<TrustedContact>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _AddContactSheet(),
    );
    if (created != null && mounted) {
      setState(() => _contacts = [..._contacts, created]);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${created.name} added as a trusted contact.')),
      );
    }
  }

  Future<void> _remove(TrustedContact contact) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Remove ${contact.name}?'),
        content: const Text(
            'They will no longer get your SOS alerts or job-status updates.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Remove', style: TextStyle(color: Colors.red))),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await ref.read(apiClientProvider).deleteTrustedContact(contact.id);
      if (mounted) {
        setState(() =>
            _contacts = _contacts.where((c) => c.id != contact.id).toList());
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
      appBar: AppBar(title: const Text('Trusted contacts')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_error!, textAlign: TextAlign.center),
                        const SizedBox(height: 16),
                        ElevatedButton(
                            onPressed: _load, child: const Text('Try again')),
                      ],
                    ),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    const Text(
                      'SOS shares your live location with these people, plus support. Add up to 5 family members or close friends.',
                      style: TextStyle(color: Colors.grey, fontSize: 13),
                    ),
                    const SizedBox(height: 8),
                    Text('${_contacts.length} of 5 added',
                        style: const TextStyle(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 12),
                    if (_contacts.isEmpty)
                      const Card(
                        child: ListTile(
                          leading: Icon(Icons.contacts_outlined),
                          title: Text('No trusted contacts yet'),
                          subtitle: Text(
                              'Add at least one contact before you can use SOS.'),
                        ),
                      ),
                    ..._contacts.map(
                      (c) => Card(
                        child: ListTile(
                          leading: CircleAvatar(
                              child: Text(c.name.isNotEmpty ? c.name[0] : '?')),
                          title: Text(c.name),
                          subtitle: Text(
                              '${c.phone}${c.relation != null ? ' · ${c.relation}' : ''}'),
                          trailing: IconButton(
                            icon: const Icon(Icons.delete_outline,
                                color: Colors.red),
                            tooltip: 'Remove',
                            onPressed: () => _remove(c),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton.icon(
                        onPressed:
                            _contacts.length >= 5 ? null : _add,
                        icon: const Icon(Icons.person_add_outlined),
                        label: const Text('Add trusted contact'),
                      ),
                    ),
                  ],
                ),
    );
  }
}

class _AddContactSheet extends ConsumerStatefulWidget {
  const _AddContactSheet();

  @override
  ConsumerState<_AddContactSheet> createState() => _AddContactSheetState();
}

class _AddContactSheetState extends ConsumerState<_AddContactSheet> {
  final _nameController = TextEditingController();
  final _phoneController = TextEditingController(text: '+92');
  final _relationController = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    final name = _nameController.text.trim();
    final phone = _phoneController.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Enter the contact’s name.');
      return;
    }
    if (!TrustedContact.isValidPhone(phone)) {
      setState(() => _error =
          'Phone must be a Pakistani number like +923001234567.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final created = await ref.read(apiClientProvider).addTrustedContact(
            name: name,
            phone: phone,
            relation: _relationController.text.trim().isEmpty
                ? null
                : _relationController.text.trim(),
          );
      if (mounted) Navigator.pop(context, created);
    } on ApiException catch (e) {
      setState(() => _error = e.userMessage);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 20,
        right: 20,
        top: 20,
        bottom: MediaQuery.of(context).viewInsets.bottom + 20,
      ),
      child: ListView(
        shrinkWrap: true,
        children: [
          const Text('Add trusted contact',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 16),
          TextField(
            controller: _nameController,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Name'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _phoneController,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(
              labelText: 'Phone',
              hintText: '+923001234567',
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _relationController,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(
              labelText: 'Relation (optional)',
              hintText: 'e.g. wife, brother, friend',
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Colors.red)),
          ],
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _busy ? null : _submit,
              child: Text(_busy ? 'Adding…' : 'Add contact'),
            ),
          ),
        ],
      ),
    );
  }
}
