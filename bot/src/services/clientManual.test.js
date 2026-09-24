import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientManual, CLIENT_COMMANDS, MANUAL_TITLE } from './clientManual.js'
import { getClientCommands } from '../config/commands.js'

test('the manual names every client command except verify, so a new one cannot ship undocumented', () => {
  const json = clientManual().toJSON()
  const text = [json.title, json.description, ...(json.fields ?? []).flatMap((f) => [f.name, f.value])].join('\n')
  for (const name of getClientCommands().filter((n) => n !== 'verify')) {
    assert.match(text, new RegExp(`/${name}\\b`), `manual mentions /${name}`)
  }
  assert.equal(json.title, MANUAL_TITLE)
})

test('every descriptor is a command the gate allows, with syntax and an example', () => {
  const allowed = new Set(getClientCommands())
  for (const c of CLIENT_COMMANDS) {
    assert.ok(allowed.has(c.name), `${c.name} is in clientCommands`)
    assert.match(c.syntax, new RegExp(`^/${c.name}`))
    assert.ok(c.example.length > 0)
  }
})

test('the manual explains "Waiting on you" and that documents can be attached', () => {
  const json = clientManual().toJSON()
  const text = [json.description, ...(json.fields ?? []).map((f) => f.value)].join('\n')
  assert.match(text, /Waiting on you/)
  assert.match(text, /three documents/i)
})
