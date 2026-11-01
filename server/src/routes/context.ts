// Route table types and the per-family request contexts.
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import type { MediaCapabilities } from '../archive/capabilities';
import type { validateRealSession } from '../auth';
import type { cognitoServiceFor, CognitoService, UsedStates } from '../auth/cognito';
import { type RuntimeConfig } from '../config';
import { type RewindDatabase } from '../db';
import { type StoredJobOptions } from '../jobs';
import { type UploadIntentDependencies } from '../media/upload-intents';
import type { RealtimeHub } from '../realtime';
import { type ReminderProviders } from '../reminders/outbox';

import type { RegistrationRateLimiter, RequestLimiters } from './limits';

export interface RuntimeServerOptions extends StoredJobOptions {
  reminderProviders?: ReminderProviders;
  reminderWebPushPublicKey?: string;
  uploadIntents?: Omit<UploadIntentDependencies, 'now'>;
  mediaCapabilities?: MediaCapabilities;
  now?: () => Date;
  realtimeHub?: RealtimeHub;
  realtimeHeartbeatIntervalMs?: number;
  requestLimiters?: RequestLimiters;
  /** Tests inject a Cognito service; production builds one from config.cognito. */
  cognito?: CognitoService;
}

/** A route matches one or more methods ('*' for any) and an exact path or pattern. */
export interface Route<C> {
  methods: readonly string[] | '*';
  path: string | RegExp;
  handle: (ctx: C, match: RegExpMatchArray) => void | Promise<void>;
}

/** The first route whose method and path match, in table order. */
export function findRoute<C>(
  routes: readonly Route<C>[],
  method: string | undefined,
  pathname: string,
): { route: Route<C>; match: RegExpMatchArray } | null {
  for (const route of routes) {
    if (route.methods !== '*' && !route.methods.includes(method ?? '')) continue;
    const match =
      typeof route.path === 'string'
        ? pathname === route.path
          ? (Object.assign([pathname], { index: 0, input: pathname }) as RegExpMatchArray)
          : null
        : pathname.match(route.path);
    if (match) return { route, match };
  }
  return null;
}

/** Shared by the chat, contribution, premiere and Archive routes. */
export interface MediaRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  config: RuntimeConfig;
  database: RewindDatabase;
  options: RuntimeServerOptions;
  now: () => Date;
  requestLimiters: RequestLimiters;
  url: URL;
}

export type ValidRealSession = Extract<ReturnType<typeof validateRealSession>, { status: 'valid' }>;

/** /real/* routes run after the transport and session checks. */
export interface RealRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  config: RuntimeConfig;
  database: RewindDatabase;
  url: URL;
  now: Date;
  currentClock: () => Date;
  options: RuntimeServerOptions;
  token: string | null;
  session: ValidRealSession;
  limits: RequestLimiters;
}

/** /auth/* routes run after the transport check. */
export interface AuthRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  config: RuntimeConfig;
  database: RewindDatabase;
  registrationRateLimiter: RegistrationRateLimiter;
  cognitoStates: UsedStates;
  url: URL;
  now: Date;
  options: RuntimeServerOptions;
  cognito: ReturnType<typeof cognitoServiceFor>;
  passwordSignIn: boolean;
}
