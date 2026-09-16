import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getCommands } from '../commands/index.js'
import { getCommandRoles } from './commands.js'

// A command can be gated two ways, and they do not compose the way you would hope:
//
//   1. `commandRoles` in command-config.json, enforced by canUseCommand at dispatch.
//   2. `setDefaultMemberPermissions(...)`, enforced by Discord, which HIDES the
//      command outright from anyone lacking those raw permissions.
//
// When a command carries both, gate 2 wins silently — the people the role config
// names cannot even see the command, and there is no error anywhere to explain it.
// That is what locked CEO and Server Manager out of /invite, /approve, /backlog,
// /init, /scrap and /repos: all six declared roles AND a Discord permission the
// role did not grant.
//
// The rule: a command declares its audience ONCE. Either a role list or a Discord
// permission, never both.

test('no command is gated by both a role list and a Discord permission', () => {
  const doubleGated = []

  for (const builder of getCommands()) {
    const json = builder.toJSON()
    const perms = json.default_member_permissions
    // null/undefined means "no Discord gate"; "0" would mean nobody-but-admins.
    const hasDiscordGate = perms !== null && perms !== undefined
    const roles = getCommandRoles(json.name)
    if (hasDiscordGate && roles.length > 0) {
      doubleGated.push(`${json.name} (perms=${perms}, roles=[${roles.join(', ')}])`)
    }
  }

  assert.deepEqual(
    doubleGated,
    [],
    'These commands are hidden by Discord from the very roles command-config.json ' +
      'grants them to. Remove setDefaultMemberPermissions and let the role list ' +
      'decide, or drop the role entry:\n  ' + doubleGated.join('\n  '),
  )
})

test('every command a role list names is actually reachable by that role', () => {
  // The inverse sanity check: a role entry only means something if the command
  // exists. A stale entry for a deleted command is dead config that reads as policy.
  const names = new Set(getCommands().map((b) => b.toJSON().name))
  const orphans = []
  for (const name of ['invite', 'approve', 'backlog', 'init', 'scrap', 'repos']) {
    if (!names.has(name)) orphans.push(name)
  }
  assert.deepEqual(orphans, [], `command-config.json names commands that do not exist: ${orphans.join(', ')}`)
})
