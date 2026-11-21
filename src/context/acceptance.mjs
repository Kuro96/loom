import { contextError } from './budget.mjs';

const REVIEW_FAILURE_CODES=new Set(['LOOM_REVIEW_JSON','LOOM_ACCEPTANCE_SCHEMA','LOOM_REVIEW_TRUNCATED']);
const PROVIDER_FAILURE_CODES=new Set(['SERVER','AUTH','RATE_LIMIT','TRANSPORT']);
export function isAcceptanceFailure(error) {
  return REVIEW_FAILURE_CODES.has(error.code) ||
    (error.failure?.code===error.code && PROVIDER_FAILURE_CODES.has(error.code));
}

export function acceptanceValue(value,checks) {
  if(!value || typeof value.passed!=='boolean' || typeof value.summary!=='string' || !value.summary.trim() || !Array.isArray(value.evidence) || !value.evidence.every(item=>typeof item==='string') || (value.passed && !value.evidence.some(item=>item.trim()))) {
    throw contextError('LOOM_ACCEPTANCE_SCHEMA','Acceptance requires a boolean verdict, summary and concrete evidence references');
  }
  const checksPassed=checks.every(check=>check.passed===true);
  return {passed:value.passed&&checksPassed,summary:checksPassed?value.summary:`Objective checks failed. ${value.summary}`,evidence:value.evidence};
}
