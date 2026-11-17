import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/phase3_models.dart';

/// Phase 3 — Teams (provider): my teams, create, members, earnings.
/// Members see only their own assigned jobs; the owner sees all.
/// Staff seats are limited by my subscription plan.
class TeamsScreen extends ConsumerStatefulWidget {
  const TeamsScreen({super.key});

  @override
  ConsumerState<TeamsScreen> createState() => _TeamsScreenState();
}

class _TeamsScreenState extends ConsumerState<TeamsScreen> {
  final _name = TextEditingController();
  List<Team> _teams = [];
  Team? _selected;
  List<TeamMember> _members = [];
  TeamEarnings? _earnings;
  bool _loading = true;
  String? _error;
  String? _msg;

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
      _teams = await ref.read(apiClientProvider).listMyTeams();
      if (_teams.isNotEmpty) await _select(_teams.first);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not load teams.');
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _select(Team team) async {
    _selected = team;
    try {
      _members =
          await ref.read(apiClientProvider).listTeamMembers(team.id);
      _earnings =
          await ref.read(apiClientProvider).getTeamEarnings(team.id);
    } on ApiException catch (e) {
      setState(() => _msg = e.message);
    }
    if (mounted) setState(() {});
  }

  Future<void> _create() async {
    if (_name.text.trim().isEmpty) return;
    try {
      final team =
          await ref.read(apiClientProvider).createTeam(_name.text.trim());
      _name.clear();
      setState(() => _msg = 'Team "${team.name}" created.');
      await _load();
    } on ApiException catch (e) {
      setState(() => _msg = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('My team')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!))
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (_msg != null) ...[
                      Text(_msg!),
                      const SizedBox(height: 12),
                    ],
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _name,
                            decoration: const InputDecoration(
                              labelText: 'New team name',
                              border: OutlineInputBorder(),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        ElevatedButton(
                            onPressed: _create, child: const Text('Create')),
                      ],
                    ),
                    const SizedBox(height: 12),
                    if (_teams.isEmpty)
                      const Text(
                          'No team yet — create one. One team per provider.'),
                    ..._teams.map((t) => Card(
                          color: _selected?.id == t.id
                              ? Colors.teal.shade50
                              : null,
                          child: ListTile(
                            title: Text(t.name),
                            subtitle: Text('My role: ${t.myRole ?? '—'}'),
                            onTap: () => _select(t),
                          ),
                        )),
                    if (_selected != null) ...[
                      const SizedBox(height: 12),
                      Text('Members — ${_selected!.name}',
                          style: const TextStyle(fontWeight: FontWeight.bold)),
                      if (_members.isEmpty)
                        const Text('No members yet.'),
                      ..._members.map((m) => ListTile(
                            title: Text(m.userId),
                            subtitle: Text('${m.role} · ${m.status}'),
                          )),
                      if (_earnings != null) ...[
                        const SizedBox(height: 12),
                        const Text('Earnings',
                            style:
                                TextStyle(fontWeight: FontWeight.bold)),
                        ListTile(
                          title: Text(
                              '${_earnings!.jobsSettled} jobs settled'),
                          subtitle: Text(
                              'Gross PKR ${_earnings!.grossPkr.round()} · commission PKR ${_earnings!.commissionPkr.round()} · net PKR ${_earnings!.netEarningsPkr.round()}'),
                        ),
                      ],
                      const Text(
                        'Workers see only jobs assigned to them. Invite members from the team owner account.',
                        style: TextStyle(fontSize: 12, color: Colors.grey),
                      ),
                    ],
                  ],
                ),
    );
  }
}
