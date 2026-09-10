import type { CycleRepository } from '../domain/cycles';
import type { AsyncGroupRepository } from '../domain/profiles';
import type { RuntimeClient } from './local-runtime-client';

export interface RuntimeRepositories {
  groupRepository: AsyncGroupRepository;
  cycleRepository: CycleRepository;
}

export function createRuntimeRepositories(client: RuntimeClient): RuntimeRepositories {
  return {
    groupRepository: {
      getGroupForMember: (actingMemberId: string) => client.getGroupForMember(actingMemberId),
    },
    cycleRepository: {
      getCurrentCycle: (groupId, actingMemberId) => client.getCurrentCycle(groupId, actingMemberId),
    },
  };
}
