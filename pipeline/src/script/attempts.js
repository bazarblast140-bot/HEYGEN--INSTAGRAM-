// Paid model calls. A schema slip gets another pass; an auth or balance error
// does not. Three tries is the cap — there is no fourth automatic call, and a
// salvage after the loop reuses the last reply instead of asking again.
export const MAX_MODEL_ATTEMPTS = 3;
