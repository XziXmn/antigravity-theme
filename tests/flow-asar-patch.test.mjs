/**
 * tests/flow-asar-patch.test.mjs — Reversible Equal-Length app.asar Redirect & Upgrade-Safe Backup Tests
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ENDPOINT_FIND,
  buildEqualLengthReplacement,
  getAsarPatchStatus,
  applyAsarPatch,
  rollbackAsarPatch
} from '../core/flow/asar-patch.mjs';

test('equal-length asar patch preserves byte size, backs up original, rolls back cleanly, and protects host upgrades', () => {
  const repl = buildEqualLengthReplacement(50100);
  assert.equal(Buffer.byteLength(repl, 'utf8'), Buffer.byteLength(DEFAULT_ENDPOINT_FIND, 'utf8'));
  assert.ok(repl.startsWith('http://127.0.0.1:50100/ap'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-asar-test-'));
  try {
    const fakeAsar = path.join(tmpDir, 'app.asar');
    const backupDir = path.join(tmpDir, 'backups');
    const origContent = Buffer.from(
      `HEADER--${DEFAULT_ENDPOINT_FIND}/v1internal--MID--${DEFAULT_ENDPOINT_FIND}--TAIL`,
      'utf8'
    );
    fs.writeFileSync(fakeAsar, origContent);

    const st0 = getAsarPatchStatus({ asarPath: fakeAsar, port: 50100, backupDir, platform: 'win32' });
    assert.equal(st0.status, 'original');
    assert.equal(st0.hits, 2);

    // macOS guard blocks accidental unsigned write unless explicitly confirmed
    const macGuard = applyAsarPatch({ asarPath: fakeAsar, port: 50100, backupDir, platform: 'darwin' });
    assert.equal(macGuard.ok, false);

    // Apply patch on Windows
    const applied = applyAsarPatch({ asarPath: fakeAsar, port: 50100, backupDir, platform: 'win32' });
    assert.equal(applied.ok, true);
    assert.equal(applied.patchedCount, 2);
    assert.equal(fs.readFileSync(fakeAsar).length, origContent.length);

    // Idempotent second apply
    const appliedAgain = applyAsarPatch({ asarPath: fakeAsar, port: 50100, backupDir, platform: 'win32' });
    assert.equal(appliedAgain.ok, true);
    assert.equal(appliedAgain.already, true);

    const st1 = getAsarPatchStatus({ asarPath: fakeAsar, port: 50100, backupDir, platform: 'win32' });
    assert.equal(st1.status, 'patched');
    assert.equal(st1.hasBackup, true);

    // Rollback restores exact original bytes
    const rolled = rollbackAsarPatch({ asarPath: fakeAsar, port: 50100, backupDir, platform: 'win32' });
    assert.equal(rolled.ok, true);
    assert.deepEqual(fs.readFileSync(fakeAsar), origContent);

    // Upgrade safety: host updates app.asar to a new official version -> rollback must NOT overwrite with old backup
    const upgradedContent = Buffer.from(
      `NEW_V2_HEADER--${DEFAULT_ENDPOINT_FIND}/v1internal--NEW_TAIL`,
      'utf8'
    );
    fs.writeFileSync(fakeAsar, upgradedContent);
    const rolledAfterUpgrade = rollbackAsarPatch({ asarPath: fakeAsar, port: 50100, backupDir, platform: 'win32' });
    assert.equal(rolledAfterUpgrade.ok, true);
    assert.equal(rolledAfterUpgrade.alreadyOriginal, true);
    assert.deepEqual(fs.readFileSync(fakeAsar), upgradedContent);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
