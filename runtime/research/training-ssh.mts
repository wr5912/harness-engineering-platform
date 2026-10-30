import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, closeSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, isIP } from 'node:net'
import { dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTrainingServerDirectory, resolveTrainingServerCredentialPath, type TrainingServer } from '../../platform/plugin/src/agents/training-servers.ts'

type Card = { cwd: string; argv: string[]; env: Record<string, string>; unset_env: string[]; requires?: string[] }
type Credential = { schema_version: 1; kind: 'ssh_password'; password: string } | { schema_version: 1; kind: 'ssh_key'; identity_file?: string }
type ForwardMapping = { bind_address: string; local_port: number; remote_port: number }
type Receipt = { schema_version: 1; operation: 'exec' | 'transfer' | 'forward'; id: string; server_id: string; server: TrainingServer; directory_revision: string;
  status: string; created_at: string; updated_at: string; remote: string; card_sha256?: string; card_path?: string;
  pid?: number; start_time?: string; exit_code?: number; exit_signal?: string; local?: string; direction?: string; sha256?: string; error?: string;
  mappings?: ForwardMapping[]; ssh_argv?: string[]; listeners_verified?: boolean; control_socket?: string }
type Transport = { server: TrainingServer; env: NodeJS.ProcessEnv; options: string[]; cleanup(): void }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
async function fileHash(file: string) { const digest = createHash('sha256'); for await (const part of createReadStream(file)) digest.update(part); return digest.digest('hex') }
const now = () => new Date().toISOString()
function requireValue(value: unknown, code: string): asserts value { if (!value) throw new Error(code) }
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
function json(file: string): any { return JSON.parse(readFileSync(file, 'utf8')) }
function plain(value: any) { return !!value && typeof value === 'object' && !Array.isArray(value) }
function remotePath(root: string, path: string) {
  requireValue(isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path), 'REMOTE_ABSOLUTE_PATH_REQUIRED')
  const result = posix.resolve(path), base = posix.resolve(root)
  requireValue(result === base || result.startsWith(`${base}/`), 'REMOTE_PATH_OUTSIDE_SERVER_WORKDIR')
  return result
}
export function readCommandCard(file: string, workDir: string): Card {
  const card = json(file)
  requireValue(plain(card) && Object.keys(card).every(key => ['cwd', 'argv', 'env', 'unset_env', 'requires'].includes(key)), 'COMMAND_CARD_FIELDS_INVALID')
  requireValue(typeof card.cwd === 'string' && Array.isArray(card.argv) && card.argv[0] && card.argv.every((value: unknown) => typeof value === 'string' && !value.includes('\0')), 'COMMAND_CARD_ARGV_INVALID')
  remotePath(workDir, card.cwd)
  requireValue(plain(card.env) && Object.entries(card.env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0')), 'COMMAND_CARD_ENV_INVALID')
  requireValue(Array.isArray(card.unset_env) && card.unset_env.every((key: unknown) => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)), 'COMMAND_CARD_UNSET_ENV_INVALID')
  requireValue(card.requires === undefined || Array.isArray(card.requires) && card.requires.every((item: unknown) => typeof item === 'string'), 'COMMAND_CARD_REQUIRES_INVALID')
  return card
}
export function readSshCredential(assetRoot: string, reference: string): Credential {
  const file = resolveTrainingServerCredentialPath(assetRoot, reference), stat = lstatSync(file)
  requireValue(stat.isFile() && !stat.isSymbolicLink() && realpathSync(file) === file, 'CREDENTIAL_FILE_NOT_DEDICATED')
  let value: any
  try { value = json(file) } catch { throw new Error('SSH_CREDENTIAL_JSON_INVALID') }
  requireValue(plain(value) && value.schema_version === 1, 'SSH_CREDENTIAL_SCHEMA_INVALID')
  if (value.kind === 'ssh_password') {
    requireValue(Object.keys(value).sort().join(',') === 'kind,password,schema_version' && typeof value.password === 'string' && value.password.length && !/[\r\n\0]/.test(value.password), 'SSH_PASSWORD_CREDENTIAL_INVALID')
  } else requireValue(value.kind === 'ssh_key' && Object.keys(value).every(key => ['schema_version', 'kind', 'identity_file'].includes(key))
    && (value.identity_file === undefined || typeof value.identity_file === 'string' && isAbsolute(value.identity_file)), 'SSH_KEY_CREDENTIAL_INVALID')
  return value
}
function server(assetRoot: string, id: string) {
  const directory = readTrainingServerDirectory(assetRoot), found = directory.servers.find(server => server.id === id)
  requireValue(found, 'TRAINING_SERVER_NOT_REGISTERED')
  return { server: found, revision: directory.revision }
}
function transport(assetRoot: string, selected: TrainingServer): Transport {
  const root = realpathSync(assetRoot), state = join(root, '.local/training-ssh')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  const options = ['-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${join(state, 'known_hosts')}`, '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-o', 'LogLevel=ERROR']
  const env = { ...process.env, LC_ALL: 'C' }, cleanup: string[] = []
  const credential = selected.credentialRef ? readSshCredential(root, selected.credentialRef) : undefined
  if (selected.auth === 'password') {
    requireValue(credential?.kind === 'ssh_password', 'SSH_PASSWORD_REFERENCE_REQUIRED')
    const helper = join(state, `askpass-${process.pid}-${randomUUID()}.sh`)
    const cli = fileURLToPath(import.meta.url)
    writeFileSync(helper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} --experimental-strip-types ${shellQuote(cli)} askpass --asset-root ${shellQuote(root)} --credential-ref ${shellQuote(selected.credentialRef)} --prompt "$1"\n`, { mode: 0o700, flag: 'wx' })
    cleanup.push(helper)
    Object.assign(env, { SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'hep-training-ssh' })
    options.push('-o', 'NumberOfPasswordPrompts=1', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no')
  } else {
    requireValue(!credential || credential.kind === 'ssh_key', 'SSH_AUTH_REFERENCE_MISMATCH')
    options.push('-o', 'BatchMode=yes')
    if (credential?.kind === 'ssh_key' && credential.identity_file) options.push('-i', credential.identity_file)
  }
  return { server: selected, env, options, cleanup() { for (const file of cleanup) rmSync(file, { force: true }) } }
}
function command(connection: Transport, script: string, follow = false): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ssh', [...connection.options, '-p', String(connection.server.port), '-T', `${connection.server.user}@${connection.server.host}`, 'sh -s'], { env: connection.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    child.on('error', () => reject(new Error('SSH_TRANSPORT_START_FAILED')))
    child.stdout.on('data', chunk => { if (follow) process.stdout.write(chunk); else stdout += chunk.toString('utf8') })
    // SSH认证错误只报告稳定状态；不把认证会话或AskPass提示写入普通日志。
    child.stderr.on('data', chunk => { if (follow) process.stderr.write(chunk) })
    child.stdin.on('error', () => {})
    child.once('close', code => resolvePromise({ code: code ?? 255, stdout }))
    child.stdin.end(script)
  })
}
function save(file: string, receipt: Receipt, first = false) {
  mkdirSync(dirname(resolve(file)), { recursive: true })
  receipt.updated_at = now()
  if (first) {
    const fd = openSync(file, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  } else {
    const temporary = `${file}.${randomUUID()}.tmp`
    try { writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, file) }
    finally { rmSync(temporary, { force: true }) }
  }
}
function loadReceipt(root: string, file: string): Receipt {
  const receipt = json(file) as Receipt, current = server(root, receipt.server_id)
  requireValue(receipt.schema_version === 1 && receipt.operation === 'exec' && /^[a-f0-9-]{36}$/.test(receipt.id)
    && JSON.stringify(current.server) === JSON.stringify(receipt.server) && /^[a-f0-9]{64}$/.test(receipt.card_sha256 ?? ''), 'RECEIPT_SERVER_OR_COMMAND_BINDING_MISMATCH')
  requireValue(receipt.remote === posix.join(current.server.workDir, '.harness-training-ssh', receipt.id), 'RECEIPT_REMOTE_IDENTITY_INVALID')
  return receipt
}
export function runnerScript(card: Card, directory: string): string {
  const run = ['env', ...card.unset_env.flatMap(key => ['-u', key]), '--', ...Object.entries(card.env).map(([key, value]) => `${key}=${value}`), ...card.argv].map(shellQuote).join(' ')
  return `#!/bin/sh\numask 077\nfinish() { code=$?; printf '%s\\n' "$code" > ${shellQuote(`${directory}/exit-code.tmp`)}; mv ${shellQuote(`${directory}/exit-code.tmp`)} ${shellQuote(`${directory}/exit-code`)}; }\ntrap finish EXIT\ntrap 'exit 143' TERM HUP INT\nprintf '%s\\n' "$$" > ${shellQuote(`${directory}/pid`)}\nawk '{print $22}' "/proc/$$/stat" > ${shellQuote(`${directory}/start-time`)}\ncd ${shellQuote(card.cwd)} || exit 125\n${run} &\nchild=$!\nwait "$child"\nexit $?\n`
}
export function launchScript(card: Card, directory: string, cardSha: string): string {
  const body = Buffer.from(runnerScript(card, directory)).toString('base64')
  return `set -eu\numask 077\nmkdir -p ${shellQuote(posix.dirname(directory))}\nmkdir ${shellQuote(directory)} || exit 73\nprintf '%s' ${shellQuote(body)} | base64 -d > ${shellQuote(`${directory}/runner.sh`)}\nprintf '%s\\n' ${shellQuote(cardSha)} > ${shellQuote(`${directory}/card-sha256`)}\nnohup setsid sh ${shellQuote(`${directory}/runner.sh`)} > ${shellQuote(`${directory}/output.log`)} 2>&1 </dev/null &\nfor attempt in 1 2 3 4 5 6 7 8 9 10; do test -s ${shellQuote(`${directory}/start-time`)} && break; sleep 0.1; done\n`
}
/** 验证实际/proc出生时间、进程组及runner路径；不能只凭PID发送信号。 */
export function statusScript(receipt: Pick<Receipt, 'remote' | 'card_sha256'>, cancel = false): string {
  const dir = shellQuote(receipt.remote), runner = shellQuote(`${receipt.remote}/runner.sh`)
  return `set -u
dir=${dir}
if ! test -d "$dir"; then printf 'HSSH_STATE=not_found\\n'; exit 0; fi
if ! test "$(cat "$dir/card-sha256" 2>/dev/null)" = ${shellQuote(receipt.card_sha256!)}; then printf 'HSSH_STATE=identity_mismatch\\n'; exit 0; fi
pid=$(cat "$dir/pid" 2>/dev/null)
start=$(cat "$dir/start-time" 2>/dev/null)
case "$pid:$start" in *[!0-9:]*|:|:*|*:) printf 'HSSH_STATE=unknown\\n'; exit 0;; esac
group_active() { ps -eo pgid=,stat= | awk -v group="$pid" '$1 == group && $2 !~ /^Z/ { alive=1 } END { exit !alive }'; }
if test -f "$dir/cancel-requested"; then
  if group_active; then printf 'HSSH_STATE=stopping\\n'; else printf 'HSSH_STATE=cancelled\\n'; fi
  if test -s "$dir/exit-code"; then printf 'HSSH_EXIT='; cat "$dir/exit-code"; fi
  exit 0
fi
if test -s "$dir/exit-code"; then printf 'HSSH_STATE=completed\\nHSSH_EXIT='; cat "$dir/exit-code"; exit 0; fi
if ! test -r "/proc/$pid/stat"; then printf 'HSSH_STATE=unknown\\n'; exit 0; fi
actual=$(awk '{print $22}' "/proc/$pid/stat")
pgid=$(ps -o pgid= -p "$pid" | tr -d ' ')
if ! test "$actual" = "$start" || ! test "$pgid" = "$pid" || ! tr '\\000' '\\n' < "/proc/$pid/cmdline" | grep -F -x -- ${runner} >/dev/null; then printf 'HSSH_STATE=identity_mismatch\\n'; exit 0; fi
printf 'HSSH_PID=%s\\nHSSH_START=%s\\n' "$pid" "$start"
${cancel ? `touch "$dir/cancel-requested"
/bin/kill -TERM -- "-$pid"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if ! group_active; then printf 'HSSH_STATE=cancelled\\n'; exit 0; fi
  sleep 0.2
done
printf 'HSSH_STATE=stopping\\n'` : "printf 'HSSH_STATE=running\\n'"}
`
}
function markers(text: string) {
  const fields = Object.fromEntries(text.split('\n').filter(line => /^HSSH_[A-Z]+=/.test(line)).map(line => { const at = line.indexOf('='); return [line.slice(5, at), line.slice(at + 1)] }))
  requireValue(['not_found', 'completed', 'unknown', 'identity_mismatch', 'running', 'cancelled', 'stopping'].includes(fields.STATE ?? ''), 'SSH_STATUS_RESPONSE_INVALID')
  if (fields.PID) requireValue(/^[0-9]+$/.test(fields.PID) && /^[0-9]+$/.test(fields.START ?? ''), 'SSH_PROCESS_IDENTITY_INVALID')
  if (fields.EXIT) requireValue(/^[0-9]+$/.test(fields.EXIT) && Number(fields.EXIT) <= 255, 'SSH_EXIT_STATUS_INVALID')
  return fields
}
async function observe(connection: Transport, receipt: Receipt, cancel = false) {
  const identity = `if test -s ${shellQuote(`${receipt.remote}/pid`)} && test -s ${shellQuote(`${receipt.remote}/start-time`)}; then printf 'HSSH_PID='; cat ${shellQuote(`${receipt.remote}/pid`)}; printf 'HSSH_START='; cat ${shellQuote(`${receipt.remote}/start-time`)}; fi\n`
  const response = await command(connection, identity + statusScript(receipt, cancel))
  requireValue(response.code === 0, 'SSH_STATUS_TRANSPORT_FAILED')
  const found = markers(response.stdout)
  requireValue(found.STATE !== 'identity_mismatch', 'REMOTE_PROCESS_IDENTITY_MISMATCH')
  if (receipt.pid !== undefined && found.PID) requireValue(receipt.pid === Number(found.PID) && receipt.start_time === found.START, 'REMOTE_PROCESS_IDENTITY_MISMATCH')
  if (found.PID) { receipt.pid = Number(found.PID); receipt.start_time = found.START }
  receipt.status = found.STATE === 'completed' ? Number(found.EXIT) === 0 ? 'completed' : 'failed' : found.STATE
  if (found.EXIT !== undefined) receipt.exit_code = Number(found.EXIT)
  return receipt
}
export async function executeCard(root: string, serverId: string, cardFile: string, receiptFile: string): Promise<Receipt> {
  requireValue(!existsSync(receiptFile), 'EXECUTION_RECEIPT_ALREADY_EXISTS_CHECK_STATUS')
  const selected = server(root, serverId), card = readCommandCard(cardFile, selected.server.workDir), id = randomUUID(), stamp = now()
  const receipt: Receipt = { schema_version: 1, operation: 'exec', id, server_id: serverId, server: selected.server, directory_revision: selected.revision,
    card_sha256: hash(readFileSync(cardFile)), card_path: resolve(cardFile), status: 'preparing', created_at: stamp, updated_at: stamp,
    remote: posix.join(selected.server.workDir, '.harness-training-ssh', id) }
  const connection = transport(root, selected.server)
  save(receiptFile, receipt, true)
  let interrupted = false, admitted = false, cancelling: Promise<unknown> | undefined
  const stop = () => { interrupted = true; if (admitted && !cancelling) cancelling = observe(connection, receipt, true).catch(() => { receipt.status = 'unknown' }) }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  try {
    const launched = await command(connection, launchScript(card, receipt.remote, receipt.card_sha256!))
    requireValue(launched.code === 0, 'SSH_LAUNCH_TRANSPORT_FAILED_CHECK_STATUS')
    await observe(connection, receipt); save(receiptFile, receipt)
    admitted = true
    process.stdout.write(JSON.stringify({ receipt: resolve(receiptFile), id, status: receipt.status, pid: receipt.pid ?? null }) + '\n')
    if (interrupted) stop()
    if (receipt.status === 'running' && receipt.pid) {
      const dir = shellQuote(receipt.remote)
      const followed = await command(connection, `set -eu\ndir=${dir}\noffset=0\nemit() { size=$(wc -c < "$dir/output.log"); count=$((size-offset)); if test "$count" -gt 0; then dd if="$dir/output.log" iflag=skip_bytes,count_bytes skip="$offset" count="$count" status=none; fi; offset=$size; }\nwhile :; do emit; if test -s "$dir/exit-code"; then emit; break; fi; if ! test -r /proc/${receipt.pid}/stat || test "$(awk '{print $3}' /proc/${receipt.pid}/stat)" = Z; then break; fi; sleep 1; done\n`, true)
      requireValue(followed.code === 0, 'SSH_LOG_FOLLOW_DISCONNECTED_CHECK_STATUS')
    } else await command(connection, `cat ${shellQuote(`${receipt.remote}/output.log`)}\n`, true)
    await cancelling
    await observe(connection, receipt)
    return receipt
  } catch (error) {
    receipt.status = 'unknown'; receipt.error = error instanceof Error ? error.message : 'SSH_EXECUTION_UNKNOWN'; throw error
  } finally {
    save(receiptFile, receipt); connection.cleanup(); process.off('SIGTERM', stop); process.off('SIGINT', stop)
  }
}

export function readForwardMappings(file: string): ForwardMapping[] {
  const mappings = json(file)
  requireValue(Array.isArray(mappings) && mappings.length > 0, 'FORWARD_MAPPINGS_REQUIRED')
  for (const mapping of mappings) requireValue(plain(mapping) && Object.keys(mapping).sort().join(',') === 'bind_address,local_port,remote_port'
    && typeof mapping.bind_address === 'string' && isIP(mapping.bind_address)
    && [mapping.local_port, mapping.remote_port].every(port => Number.isSafeInteger(port) && port >= 1 && port <= 65535), 'FORWARD_MAPPING_INVALID')
  requireValue(new Set(mappings.map(mapping => mapping.local_port)).size === mappings.length, 'FORWARD_LOCAL_PORT_DUPLICATE')
  return mappings
}
function localProcess(pid: number): { start: string; argv: string[]; state: string } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { start: fields[19]!, state: fields[0]!, argv: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
function forwardProcess(receipt: Receipt) {
  if (!receipt.pid || !receipt.start_time) return undefined
  const actual = localProcess(receipt.pid)
  if (!actual || actual.state === 'Z') return undefined
  // OpenSSH保持前台；脚本测试边界可有解释器前缀，完整SSH参数必须逐项相等。
  requireValue(actual.start === receipt.start_time && JSON.stringify(actual.argv.slice(-receipt.ssh_argv!.length)) === JSON.stringify(receipt.ssh_argv), 'LOCAL_FORWARD_PROCESS_IDENTITY_MISMATCH')
  return actual
}
function ownedListeningPorts(pid: number) {
  const sockets = new Set<string>()
  for (const entry of readdirSync(`/proc/${pid}/fd`)) {
    try { const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${entry}`))?.[1]; if (inode) sockets.add(inode) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const ports = new Set<number>()
  for (const name of ['tcp', 'tcp6']) for (const row of readFileSync(`/proc/${pid}/net/${name}`, 'utf8').trim().split('\n').slice(1)) {
    const fields = row.trim().split(/\s+/)
    if (fields[3] === '0A' && sockets.has(fields[9]!)) ports.add(parseInt(fields[1]!.split(':')[1]!, 16))
  }
  return ports
}
function observeForward(receipt: Receipt) {
  if (!forwardProcess(receipt)) { receipt.status = receipt.status === 'failed' ? 'failed' : receipt.pid ? 'closed' : 'unknown'; receipt.listeners_verified = false; return receipt }
  let ports: Set<number>
  try { ports = ownedListeningPorts(receipt.pid!) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; receipt.status = 'closed'; receipt.listeners_verified = false; return receipt }
  receipt.listeners_verified = receipt.mappings!.every(mapping => ports.has(mapping.local_port))
  receipt.status = receipt.status === 'stopping' ? 'stopping' : receipt.listeners_verified ? 'running' : 'starting'
  return receipt
}
function loadForwardReceipt(root: string, file: string): Receipt {
  const receipt = json(file) as Receipt, selected = server(root, receipt.server_id)
  requireValue(receipt.schema_version === 1 && receipt.operation === 'forward' && /^[a-f0-9-]{36}$/.test(receipt.id)
    && JSON.stringify(selected.server) === JSON.stringify(receipt.server) && receipt.remote === '127.0.0.1'
    && Array.isArray(receipt.mappings) && receipt.mappings.length > 0 && Array.isArray(receipt.ssh_argv)
    && receipt.ssh_argv.every(arg => typeof arg === 'string')
    && (receipt.control_socket === undefined || receipt.control_socket === forwardSocket(root, receipt.id)), 'FORWARD_RECEIPT_BINDING_INVALID')
  return receipt
}
function forwardSocket(root: string, id: string) { return join(realpathSync(root), '.local/training-ssh', `forward-${id}.sock`) }
// Linux AF_UNIX限制地址长度；目录FD别名保留同一共享文件身份，也支持较长的工作区路径。
function socketAddress(file: string) {
  const fd = openSync(dirname(file), 'r')
  return { path: `/proc/self/fd/${fd}/${posix.basename(file)}`, close() { closeSync(fd) } }
}
function forwardBinding(receipt: Receipt) {
  return hash(JSON.stringify([receipt.id, receipt.server, receipt.mappings, receipt.ssh_argv, receipt.pid, receipt.start_time]))
}
/** 每次native bash可能使用不同PID命名空间；由持有SSH的原进程核验及停止自己的子进程。 */
async function requestForwardOwner(receipt: Receipt, cancel: boolean): Promise<Receipt> {
  if (!receipt.control_socket) return { ...receipt, status: 'unknown', listeners_verified: false, error: 'FORWARD_OWNER_CONTROL_UNAVAILABLE' }
  const binding = forwardBinding(receipt)
  try {
    return await new Promise<Receipt>((done, fail) => {
      const address = socketAddress(receipt.control_socket!), socket = createConnection(address.path)
      socket.once('close', () => address.close())
      let raw = ''
      socket.setTimeout(4500, () => socket.destroy(Object.assign(new Error('forward owner timeout'), { code: 'ETIMEDOUT' })))
      socket.on('error', fail)
      socket.once('connect', () => socket.write(JSON.stringify({ id: receipt.id, action: cancel ? 'cancel' : 'status', binding_sha256: binding }) + '\n'))
      socket.on('data', chunk => { raw += chunk.toString('utf8'); if (raw.length > 262144) socket.destroy(new Error('FORWARD_CONTROL_RESPONSE_INVALID')) })
      socket.once('end', () => {
        try {
          const result = JSON.parse(raw)
          requireValue(result.ok === true && plain(result.receipt) && forwardBinding(result.receipt) === binding, 'FORWARD_CONTROL_BINDING_MISMATCH')
          done(result.receipt)
        } catch (error) { fail(error) }
      })
    })
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    // Owner已保存的终态可读；失联不能从当前namespace的/proc推定另一Job已关闭。
    return ['closed', 'failed'].includes(receipt.status) ? receipt
      : { ...receipt, status: 'unknown', listeners_verified: false, error: 'FORWARD_OWNER_UNREACHABLE' }
  }
}
/** 前台OpenSSH由native Job托管；仅核验本地SSH和监听，不推断远端模型状态。 */
export async function forwardPorts(root: string, serverId: string, mappingsFile: string, receiptFile: string): Promise<Receipt> {
  requireValue(!existsSync(receiptFile), 'FORWARD_RECEIPT_ALREADY_EXISTS_CHECK_STATUS')
  const selected = server(root, serverId), mappings = readForwardMappings(mappingsFile), stamp = now()
  const connection = transport(root, selected.server)
  const args = [...connection.options, '-o', 'ExitOnForwardFailure=yes', '-o', 'ForkAfterAuthentication=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no', '-p', String(selected.server.port), '-N', '-T',
    ...mappings.flatMap(mapping => ['-L', `${isIP(mapping.bind_address) === 6 ? `[${mapping.bind_address}]` : mapping.bind_address}:${mapping.local_port}:127.0.0.1:${mapping.remote_port}`]), `${selected.server.user}@${selected.server.host}`]
  const receipt: Receipt = { schema_version: 1, operation: 'forward', id: randomUUID(), server_id: serverId, server: selected.server,
    directory_revision: selected.revision, status: 'starting', created_at: stamp, updated_at: stamp, remote: '127.0.0.1', mappings, ssh_argv: args, listeners_verified: false }
  receipt.control_socket = forwardSocket(root, receipt.id)
  let control: ReturnType<typeof createServer> | undefined
  let controlAddress: ReturnType<typeof socketAddress> | undefined
  let child: ReturnType<typeof spawn> | undefined
  let interrupted = false
  const stop = () => { interrupted = true; receipt.status = 'stopping'; child?.kill('SIGTERM') }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  try {
    save(receiptFile, receipt, true)
    child = spawn('ssh', args, { env: connection.env, stdio: ['ignore', 'ignore', 'ignore'] })
    const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
      child!.once('error', () => fail(new Error('SSH_FORWARD_START_FAILED')))
      child!.once('close', (code, signal) => done({ code, signal }))
    })
    // 立即订阅失败，启动阶段也不留下unhandled rejection。
    let ended = false
    void finished.then(() => { ended = true }, () => { ended = true })
    receipt.pid = child.pid
    if (receipt.pid) receipt.start_time = localProcess(receipt.pid)?.start
    const binding = forwardBinding(receipt)
    control = createServer(socket => {
      let raw = '', handled = false
      socket.setTimeout(4500, () => socket.destroy())
      socket.on('error', () => {})
      socket.on('data', chunk => {
        raw += chunk.toString('utf8')
        if (raw.length > 4096) { socket.destroy(); return }
        if (handled || !raw.includes('\n')) return
        handled = true
        void (async () => {
          const request = JSON.parse(raw.trim())
          requireValue(request.id === receipt.id && request.binding_sha256 === binding
            && ['status', 'cancel'].includes(request.action), 'FORWARD_CONTROL_BINDING_MISMATCH')
          if (request.action === 'cancel' && !ended) {
            stop()
            let timer: ReturnType<typeof setTimeout> | undefined
            try { await Promise.race([finished, new Promise(done => { timer = setTimeout(done, 3000) })]) }
            finally { clearTimeout(timer) }
          }
          if (!ended) {
            observeForward(receipt)
            if (request.action === 'cancel') receipt.status = 'stopping'
            save(receiptFile, receipt)
          }
          socket.end(JSON.stringify({ ok: true, receipt }))
        })().catch(() => socket.end(JSON.stringify({ ok: false, error: 'FORWARD_CONTROL_BINDING_MISMATCH' })))
      })
    })
    controlAddress = socketAddress(receipt.control_socket)
    await new Promise<void>((done, fail) => { control!.once('error', fail); control!.listen(controlAddress!.path, done) })
    chmodSync(receipt.control_socket, 0o600)
    if (interrupted) stop()
    save(receiptFile, receipt)
    const deadline = Date.now() + 15000
    while (!ended) {
      observeForward(receipt)
      if (receipt.status === 'running') { save(receiptFile, receipt); process.stdout.write(JSON.stringify({ receipt: resolve(receiptFile), id: receipt.id, status: receipt.status, pid: receipt.pid, mappings }) + '\n'); break }
      if (Date.now() >= deadline) { stop(); throw new Error('SSH_FORWARD_LISTEN_TIMEOUT') }
      await new Promise(done => setTimeout(done, 50))
    }
    const outcome = await finished
    if (outcome.code !== null) receipt.exit_code = outcome.code
    if (outcome.signal) receipt.exit_signal = outcome.signal
    receipt.listeners_verified = false
    receipt.status = outcome.code === 0 || outcome.signal === 'SIGTERM' || outcome.signal === 'SIGINT' ? 'closed' : 'failed'
    requireValue(receipt.status !== 'failed', 'SSH_FORWARD_EXIT_FAILED')
    return receipt
  } catch (error) { receipt.status = 'failed'; receipt.error = error instanceof Error ? error.message : 'SSH_FORWARD_FAILED'; throw error }
  finally { save(receiptFile, receipt); if (control) control.close(() => controlAddress?.close()); rmSync(receipt.control_socket!, { force: true }); connection.cleanup(); process.off('SIGTERM', stop); process.off('SIGINT', stop) }
}
async function inspectForward(root: string, receiptFile: string, cancel: boolean) {
  const receipt = loadForwardReceipt(root, receiptFile)
  // 仅owner写生命周期回执，其他Job不能用其本地PID视图覆盖它。
  return ['closed', 'failed'].includes(receipt.status) ? receipt : requestForwardOwner(receipt, cancel)
}
export async function inspectExecution(root: string, receiptFile: string, cancel = false) {
  if (json(receiptFile).operation === 'forward') return inspectForward(root, receiptFile, cancel)
  const receipt = loadReceipt(root, receiptFile), connection = transport(root, receipt.server)
  try { await observe(connection, receipt, cancel); save(receiptFile, receipt); return receipt }
  finally { connection.cleanup() }
}
async function remoteDigest(connection: Transport, file: string) {
  const response = await command(connection, `set -eu\ntest -f ${shellQuote(file)}\nsha256sum -- ${shellQuote(file)}\n`)
  const digest = /^([a-f0-9]{64})\s/.exec(response.stdout)?.[1]
  requireValue(response.code === 0 && digest, 'REMOTE_ARTIFACT_DIGEST_UNAVAILABLE')
  return digest
}
export async function transferFile(root: string, serverId: string, direction: string, local: string, remote: string, receiptFile: string) {
  requireValue(['upload', 'download'].includes(direction) && !existsSync(receiptFile), 'TRANSFER_DIRECTION_OR_RECEIPT_INVALID')
  const selected = server(root, serverId), destination = remotePath(selected.server.workDir, remote), connection = transport(root, selected.server)
  const stamp = now(), receipt: Receipt = { schema_version: 1, operation: 'transfer', id: randomUUID(), server_id: serverId, server: selected.server,
    directory_revision: selected.revision, status: 'preparing', created_at: stamp, updated_at: stamp, direction, local: resolve(local), remote: destination }
  save(receiptFile, receipt, true)
  try {
    if (direction === 'upload') requireValue(lstatSync(local).isFile() && !lstatSync(local).isSymbolicLink(), 'TRANSFER_REGULAR_FILE_REQUIRED')
    else { requireValue(!existsSync(local), 'DOWNLOAD_TARGET_ALREADY_EXISTS'); mkdirSync(dirname(resolve(local)), { recursive: true }) }
    const before = direction === 'upload' ? await fileHash(local) : await remoteDigest(connection, destination)
    const remoteArg = `${selected.server.user}@${selected.server.host}:${destination}`
    const args = [...connection.options, '-P', String(selected.server.port), '--', ...(direction === 'upload' ? [resolve(local), remoteArg] : [remoteArg, resolve(local)])]
    const code = await new Promise<number>((done, fail) => {
      const child = spawn('scp', args, { env: connection.env, stdio: ['ignore', 'ignore', 'ignore'] })
      child.on('error', () => fail(new Error('SCP_START_FAILED'))); child.on('close', code => done(code ?? 255))
    })
    requireValue(code === 0, 'SCP_TRANSFER_FAILED')
    const after = direction === 'upload' ? await remoteDigest(connection, destination) : await fileHash(local)
    requireValue(before === after && await remoteDigest(connection, destination) === before, 'TRANSFER_CONTENT_DIGEST_MISMATCH')
    receipt.status = 'completed'; receipt.sha256 = after; return receipt
  } catch (error) { receipt.status = 'failed'; receipt.error = error instanceof Error ? error.message : 'TRANSFER_FAILED'; throw error }
  finally { save(receiptFile, receipt); connection.cleanup() }
}
function argumentsOf(args: string[]) {
  const [action, ...rest] = args, values: Record<string, string> = {}
  requireValue(action && rest.length % 2 === 0, 'CLI_ACTION_AND_NAMED_ARGUMENTS_REQUIRED')
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]!, value = rest[index + 1]!
    requireValue(key.startsWith('--') && value && !Object.hasOwn(values, key.slice(2)), 'CLI_ARGUMENT_INVALID')
    values[key.slice(2)] = value
  }
  return { action, values }
}
export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('用法：node --experimental-strip-types training-ssh.mts <exec|status|cancel|transfer|forward> --asset-root 绝对路径 --receipt 绝对路径\nexec：--server-id ID --card 命令卡JSON\nstatus/cancel：读取既有receipt，不重新派发命令；forward仅操作本地SSH隧道\ntransfer：--server-id ID --direction upload|download --local 文件 --remote 服务器工作目录内的绝对文件路径\nforward：--server-id ID --mappings JSON文件，数组项为{bind_address,local_port,remote_port}；远端固定127.0.0.1，前台由native后台Job托管。\n凭据引用：ref:training-server/<slug>；凭据只由SSH认证内部读取。\n')
    return
  }
  const { action, values } = argumentsOf(args), root = values['asset-root']
  requireValue(root && isAbsolute(root), 'ASSET_ROOT_REQUIRED')
  if (action === 'askpass') {
    requireValue(/password/i.test(values.prompt ?? ''), 'SSH_PASSWORD_PROMPT_REQUIRED')
    const credential = readSshCredential(root, values['credential-ref']!)
    requireValue(credential.kind === 'ssh_password', 'SSH_PASSWORD_REFERENCE_REQUIRED')
    process.stdout.write(credential.password + '\n'); return
  }
  const receipt = values.receipt
  requireValue(receipt && isAbsolute(receipt), 'ABSOLUTE_RECEIPT_PATH_REQUIRED')
  let result: Receipt
  if (action === 'exec') result = await executeCard(root, values['server-id']!, values.card!, receipt)
  else if (action === 'status' || action === 'cancel') result = await inspectExecution(root, receipt, action === 'cancel')
  else if (action === 'transfer') result = await transferFile(root, values['server-id']!, values.direction!, values.local!, values.remote!, receipt)
  else if (action === 'forward') result = await forwardPorts(root, values['server-id']!, values.mappings!, receipt)
  else throw new Error('CLI_ACTION_UNSUPPORTED')
  process.stdout.write(JSON.stringify(result) + '\n')
  if (!['completed', 'running', 'cancelled', 'closed'].includes(result.status)) process.exitCode = result.exit_code || 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { if (process.argv[2] !== 'askpass') process.stderr.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'TRAINING_SSH_FAILED' }) + '\n'); process.exitCode = 1 })
}
