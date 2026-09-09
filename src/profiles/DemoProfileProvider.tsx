import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';

import { DEFAULT_MEMBER_ID, demoRepository } from '../data/demo-repository';
import { selectionStore } from '../data/selection-store';
import type { MemberProfile, SelectionStore } from '../domain/profiles';

type SaveStatus = 'saved' | 'saving' | 'error';

interface DemoProfileState {
  profiles: MemberProfile[];
  currentMember: MemberProfile | null;
  saveStatus: SaveStatus;
  loadWarning: boolean;
  selectMember: (id: string) => void;
  retrySave: () => void;
}

const DemoProfileContext = createContext<DemoProfileState | null>(null);

export function DemoProfileProvider({
  children,
  store = selectionStore,
}: {
  children: ReactNode;
  store?: SelectionStore;
}) {
  const [profiles] = useState(() => demoRepository.listProfiles());
  const [currentMember, setCurrentMember] = useState<MemberProfile | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [loadWarning, setLoadWarning] = useState(false);
  const writes = useRef(Promise.resolve());
  const revision = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    const defaultMember = profiles.find((profile) => profile.id === DEFAULT_MEMBER_ID)!;
    store.load().then(
      (id) => {
        if (!cancelled) {
          setCurrentMember(profiles.find((profile) => profile.id === id) ?? defaultMember);
        }
      },
      () => {
        if (!cancelled) {
          setCurrentMember(defaultMember);
          setLoadWarning(true);
        }
      },
    );
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [profiles, store]);

  function persist(id: string) {
    const request = ++revision.current;
    setSaveStatus('saving');
    // Serial writes prevent an older selection from finishing after a newer one.
    writes.current = writes.current
      .then(() => store.save(id))
      .then(
        () => {
          if (mounted.current && request === revision.current) {
            setSaveStatus('saved');
            setLoadWarning(false);
          }
        },
        () => {
          if (mounted.current && request === revision.current) setSaveStatus('error');
        },
      );
  }

  function selectMember(id: string) {
    if (!currentMember) return;
    const member = profiles.find((profile) => profile.id === id);
    if (!member || 'kind' in demoRepository.getGroupForMember(id)) return;
    setCurrentMember(member);
    persist(id);
  }

  return (
    <DemoProfileContext.Provider
      value={{
        profiles,
        currentMember,
        saveStatus,
        loadWarning,
        selectMember,
        retrySave: () => currentMember && persist(currentMember.id),
      }}
    >
      {children}
    </DemoProfileContext.Provider>
  );
}

export function useDemoProfile() {
  const context = useContext(DemoProfileContext);
  if (!context) throw new Error('useDemoProfile requires DemoProfileProvider');
  return context;
}
