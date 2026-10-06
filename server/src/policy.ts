export interface DeniedDecision {
  allowed: false;
  status: 403;
  error: 'forbidden';
  message: 'You do not have access to this resource.';
}

export const SAFE_DENIAL: DeniedDecision = Object.freeze({
  allowed: false,
  status: 403,
  error: 'forbidden',
  message: 'You do not have access to this resource.',
});
