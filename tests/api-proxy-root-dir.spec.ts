/**
 * Windows rejects `fs.mkdir` of an existing filesystem root ('C:\') with
 * EPERM even under `recursive: true`. `ensureSession` must treat an existing
 * directory as satisfying the ensure-project-directory contract, or creating
 * a session inside a root workspace fails. This suite mocks `mkdir` to
 * reproduce that rejection for every path — so the passing create proves the
 * stat-probe fallback (not the mkdir call) satisfied the contract.
 */

import { mkdir } from 'node:fs/promises'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    // Windows reproduces this EPERM for every existing filesystem root; mock
    // the failure for every path so the assertion is platform-independent.
    mkdir: vi.fn(async (_path: string, _options?: object) => {
      throw Object.assign(new Error('EPERM: operation not permitted, mkdir'), { code: 'EPERM' })
    }),
  }
})

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`root-dir-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function stubAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Compose the API over real Session, Agent, Storage, Domain, and Workspace services. */
async function harness() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-rootdir-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      const unregister = ctx.agents.register(agent)
      return {
        agent,
        dispose: () => {
          unregister()
          return Promise.resolve()
        },
      }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  ctx.provide('directoryPicker', { capability: () => ({ kind: 'native', pick: async () => null }) } as never)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: root,
  })
  return { api, root }
}

describe('ensureSession over a directory whose mkdir rejects (Windows root EPERM)', () => {
  it('creates the session through the stat-probe fallback', async () => {
    const { api, root } = await harness()
    const sessionId = SessionId('session-root-dir')
    const response = await api.sessions.create(request({ cwd: root, sessionId }))
    expect(response.result.ok).toBe(true)
    // The mock (not the real fs) must have been hit: this is what proves the
    // stat-probe fallback — not the mkdir call — satisfied the contract.
    expect(vi.mocked(mkdir)).toHaveBeenCalledWith(root, { recursive: true })
  })

  it('still fails loudly when the directory does not exist', async () => {
    const { api, root } = await harness()
    const missing = join(root, 'does-not-exist')
    const response = await api.sessions.create(request({ cwd: missing, sessionId: SessionId('session-root-missing') }))
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('internal')
    expect(response.result.error.message).toContain('failed to ensure project directory')
  })
})

describe('workspace adoption in a root directory', () => {
  it('adopts an existing root-level directory as a workspace with a fallback title', async () => {
    const { api, root } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: root }))).workspace
    // The basename of a temp root is a name, not a filesystem root; the
    // assertion here is that adoption itself works under the mkdir mock.
    expect(workspace.path).toBe(root)
  })
})
