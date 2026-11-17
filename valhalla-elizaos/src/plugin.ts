import {
  ChannelType,
  createUniqueUuid,
  type IAgentRuntime,
  type Memory,
  type Plugin,
  type RouteResponse,
} from '@elizaos/core';
import { VALHALLA_ROLE_IDS, resolveCharacterId, type ValhallaRoleId } from './character.ts';
import { getRuntime } from './runtime-registry.ts';

type ChatBody = {
  text?: unknown;
  agent?: unknown;
  sessionId?: unknown;
  history?: unknown;
};

type ChatHistoryItem = { role: 'user' | 'assistant'; content: string };

const MAX_TEXT = 4000;
const MAX_HISTORY = 8;

function readHistory(value: unknown): ChatHistoryItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is { role: 'user' | 'assistant'; content: string } => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as { role?: unknown; content?: unknown };
      return (
        (candidate.role === 'user' || candidate.role === 'assistant') &&
        typeof candidate.content === 'string' &&
        candidate.content.trim().length > 0
      );
    })
    .slice(-MAX_HISTORY)
    .map((item) => ({ role: item.role, content: item.content.slice(0, 500) }));
}

function readSessionKey(body: ChatBody, text: string, history: ChatHistoryItem[]): string {
  const supplied = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (supplied) return supplied.slice(0, 128);
  const firstUser = history.find((item) => item.role === 'user');
  return (firstUser?.content || text).trim().slice(0, 280);
}

async function handleChat(body: ChatBody, response: RouteResponse) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    response.status(400).json({ ok: false, error: 'text_required' });
    return;
  }
  if (text.length > MAX_TEXT) {
    response.status(413).json({ ok: false, error: 'text_too_long' });
    return;
  }

  const requested =
    typeof body.agent === 'string' ? body.agent.trim().toLowerCase() : '';
  const role: ValhallaRoleId =
    (VALHALLA_ROLE_IDS as readonly string[]).includes(requested)
      ? (requested as ValhallaRoleId)
      : resolveCharacterId(text);
  const runtime = getRuntime(role);
  if (!runtime) {
    response.status(503).json({ ok: false, error: 'agent_not_ready', agent: role });
    return;
  }
  if (!runtime.messageService) {
    response.status(503).json({ ok: false, error: 'model_not_ready', agent: role });
    return;
  }

  const history = readHistory(body.history);
  const sessionKey = readSessionKey(body, text, history);
  const entityId = createUniqueUuid(runtime, `valhalla-os:visitor:${sessionKey}`);
  const roomId = createUniqueUuid(runtime, `valhalla-os:room:${role}:${sessionKey}`);
  const worldId = createUniqueUuid(runtime, `valhalla-os:world:${role}`);

  try {
    const existingRoom = await runtime.getRoom(roomId);
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId,
      worldName: 'Valhalla OS',
      userName: 'Valhalla OS visitor',
      name: 'Valhalla OS visitor',
      source: 'valhalla-os',
      type: ChannelType.DM,
      channelId: roomId,
      metadata: { valhallaRole: role },
    });

    const context =
      !existingRoom && history.length > 0
        ? `Earlier conversation:\n${history.map((item) => `${item.role}: ${item.content}`).join('\n')}\n\nCurrent user message:\n${text}`
        : text;

    const message: Memory = {
      entityId,
      roomId,
      agentId: runtime.agentId,
      content: { text: context, source: 'valhalla-os' },
      metadata: { type: 'message', source: 'valhalla-os' },
    };

    const result = await runtime.messageService.handleMessage(runtime, message, undefined, {
      timeoutDuration: 45_000,
    });
    const reply =
      typeof result.responseContent?.text === 'string' ? result.responseContent.text.trim() : '';
    if (!reply) {
      response.status(502).json({ ok: false, error: 'empty_model_reply', agent: role });
      return;
    }

    response.status(200).json({
      ok: true,
      reply,
      content: reply,
      agent: role,
      agentName: runtime.character.name,
      provider: 'elizaos',
      mode: 'paper',
    });
  } catch (error) {
    runtime.logger.error(
      { src: 'valhalla-os-chat', agent: role, error: error instanceof Error ? error.message : String(error) },
      'Chat request failed'
    );
    response.status(502).json({ ok: false, error: 'model_request_failed', agent: role });
  }
}

export const valhallaStatusPlugin: Plugin = {
  name: 'api',
  description: 'Public Valhalla health and safe role chat bridge',
  routes: [
    {
      name: 'valhalla-chat',
      path: '/valhalla/chat',
      type: 'POST',
      public: true,
      handler: async (request, response) => {
        await handleChat((request as { body?: ChatBody }).body ?? {}, response);
      },
    },
    {
      name: 'valhalla-health',
      path: '/valhalla/health',
      type: 'GET',
      public: true,
      handler: async (_request, response) => {
        response.status(200).json({
          status: 'ok',
          service: 'valhalla-elizaos',
          mode: 'paper',
          capabilities: {
            trading: 'disabled',
            privateKeyStorage: 'disabled',
            socialDispatch: 'disabled',
            vaultActions: 'disabled',
            zeusIdleJobs: 'disabled',
            perUserSandboxProvisioning: 'not_configured',
            codingProposals: 'propose_only',
            codingApproval: 'human_only',
            codingDeploy: 'disabled',
            clerkSkills: 'bundled',
            clerkMcpTools: 'read_only',
            clerkMcpMutations: 'disabled',
          },
        });
      },
    },
  ],
};

export default valhallaStatusPlugin;
