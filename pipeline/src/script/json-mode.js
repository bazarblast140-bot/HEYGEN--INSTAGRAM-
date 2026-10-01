// DeepSeek rejects response_format json_object unless the prompt contains
// the word json. The sentence below is the one every OpenAI-compatible
// script request sends; the lowercase word is in the second clause.
export const JSON_RESPONSE_LINE = 'Respond only in valid JSON. The response format is json.';
