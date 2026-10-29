import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('Docker 引导复用已有安装，缺少资源或非 root 时在写入系统前停止', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-docker-bootstrap-'))
  const script = new URL('../bootstrap-docker.sh', import.meta.url).pathname
  const bin = join(root, 'bin'), log = join(root, 'commands')
  mkdirSync(bin)
  const write = (name, value) => writeFileSync(join(bin, name), '#!/bin/sh\n' + value, { mode: 0o755 })
  const execute = () => spawnSync('/bin/bash', [script, join(root, 'missing-resources')], {
    env: { ...process.env, PATH: bin, HEP_TEST_LOG: log }, encoding: 'utf8',
  })
  try {
    write('id', 'echo 0\n')
    write('systemctl', 'echo "systemctl $*" >> "$HEP_TEST_LOG"\n')
    let result = execute()
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Docker 离线资源应包含/)
    write('docker', 'echo "docker $*" >> "$HEP_TEST_LOG"\n')
    result = execute()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(log, 'utf8'), 'systemctl enable --now docker\ndocker version --format {{.Server.Version}} {{.Server.Arch}}\ndocker compose version\n')
    write('id', 'echo 1000\n')
    result = execute()
    assert.equal(result.status, 2)
    assert.match(result.stderr, /需要 root/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
