import { expect, test } from 'bun:test';
import type { RouteResponse } from '@elizaos/core';
import valhallaStatusPlugin from '../plugin.ts';

test('public health route reports production capabilities as disabled', async () => {
  const route = valhallaStatusPlugin.routes?.find(({ name }) => name === 'valhalla-health');
  expect(route?.public).toBe(true);

  let statusCode = 0;
  let body: unknown;
  const response: RouteResponse = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      body = data;
      return this;
    },
    send() {
      return this;
    },
    end() {
      return this;
    },
  };

  await route?.handler?.({}, response, {} as never);

  expect(statusCode).toBe(200);
  expect(body).toEqual({
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
});
