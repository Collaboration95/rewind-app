import type { CycleRepository } from '../domain/cycles';
import type { AsyncGroupRepository } from '../domain/profiles';
import type { RuntimeClient } from './local-runtime-client';

export interface RuntimeRepositories {
  groupRepository: AsyncGroupRepository;
  cycleRepository: CycleRepository;
}

export function createRuntimeRepositories(
  client: RuntimeClient,
  sessionId?: string,
): RuntimeRepositories {
  return {
    groupRepository: {
      getGroupForMember: (actingMemberId: string) =>
        client.getGroupForMember(actingMemberId, sessionId),
    },
    cycleRepository: {
      getCurrentCycle: (groupId, actingMemberId) =>
        client.getCurrentCycle(groupId, actingMemberId, sessionId),
    },
  };
}
