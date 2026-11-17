import { logger, type IAgentRuntime, type Project, type ProjectAgent } from '@elizaos/core';
import { character, characters, VALHALLA_ROLE_IDS, type ValhallaRoleId } from './character.ts';
import { cerberusPlugin } from './cerberus.ts';
import { valhallaStatusPlugin } from './plugin.ts';
import { solanaMintPlugin } from './solana-mint.ts';
import { aiRoomPlugin } from './ai-room.ts';
import { valkyrieCoderPlugin } from './valkyrie-coder.ts';
import { clerkToolkitPlugin } from './clerk-toolkit.ts';
import { registerRuntime } from './runtime-registry.ts';
import { ProjectStarterTestSuite } from './__tests__/e2e/project-starter.e2e.ts';

const initializeAgent =
  (role: ValhallaRoleId, name: string) => async (runtime: IAgentRuntime) => {
    registerRuntime(role, runtime);
    logger.info({ role, agent: name, agentId: runtime.agentId }, 'Valhalla read-only agent initialized');
  };

function createProjectAgent(role: ValhallaRoleId): ProjectAgent {
  const roleCharacter = characters[role];
  const plugins = [valkyrieCoderPlugin, clerkToolkitPlugin];
  if (role === 'zeus') {
    plugins.push(valhallaStatusPlugin, solanaMintPlugin, aiRoomPlugin);
  } else if (role === 'cerberus') {
    plugins.push(cerberusPlugin, solanaMintPlugin);
  } else if (role === 'gorgo') {
    plugins.push(solanaMintPlugin);
  }
  return {
    character: roleCharacter,
    init: initializeAgent(role, roleCharacter.name),
    plugins,
    ...(role === 'zeus' ? { tests: [ProjectStarterTestSuite] } : {}),
  };
}

const project: Project = {
  agents: VALHALLA_ROLE_IDS.map(createProjectAgent),
};

export {
  character,
  characters,
  conductorCharacter,
  odinCharacter,
  wrenCharacter,
  valkyrieCharacter,
  sentinelCharacter,
  forgeCharacter,
  gorgoCharacter,
  cerberusCharacter,
  ahtiCharacter,
  hermodCharacter,
  nornsCharacter,
  gwenCharacter,
  merlinCharacter,
  characterRoster,
  resolveCharacterId,
  VALHALLA_ROLE_IDS,
  type ValhallaRoleId,
} from './character.ts';

export default project;
