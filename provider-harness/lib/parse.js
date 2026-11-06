'use strict';

/**
 * Response parsers for provider generation success.
 * Success requires a real chat/completion message payload with non-whitespace content.
 * Listing endpoints (/api/tags, /models) never count as generation.
 * Single-token content is valid. Whitespace-only / empty / refusal => unavailable.
 * Do not reject solely because content equals the prompt (legitimate short replies).
 */

function unavailable(reason, extra = {}) {
  return {
    ok: false,
    status: 'unavailable',
    reason,
    content: null,
    finishReason: null,
    doneReason: null,
    ...extra,
  };
}

function okResult(content, extra = {}) {
  return {
    ok: true,
    status: 'responded',
    reason: null,
    content,
    ...extra,
  };
}

function isNonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Parse Ollama /api/chat JSON or NDJSON stream body text.
 * Official shape: message.content + done/done_reason (https://docs.ollama.com/api/chat).
 */
function parseOllamaChatBody(bodyText, opts = {}) {
  if (bodyText == null) return unavailable('empty_body');
  const text = String(bodyText);
  if (!text.trim()) return unavailable('empty_body');

  // Prefer NDJSON if multiple lines; otherwise single JSON object.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let events = [];
  if (lines.length > 1 || (lines.length === 1 && text.includes('\n') && !text.trim().startsWith('{'))) {
    // try NDJSON
  }
  try {
    if (lines.length >= 1) {
      const parsedLines = [];
      let allJson = true;
      for (const line of lines) {
        try {
          parsedLines.push(JSON.parse(line));
        } catch {
          allJson = false;
          break;
        }
      }
      if (allJson && parsedLines.length > 0) events = parsedLines;
    }
  } catch {
    events = [];
  }

  if (events.length === 0) {
    try {
      events = [JSON.parse(text)];
    } catch {
      return unavailable('parse_error');
    }
  }

  // Error object from Ollama
  if (events.length === 1 && events[0] && typeof events[0].error === 'string') {
    return unavailable('provider_error', { detail: 'ollama_error_field' });
  }

  // Accumulate message.content from chunks; require a final done=true event for streams.
  let content = '';
  let sawDone = false;
  let doneReason = null;
  let finishReason = null;
  let model = null;

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (typeof ev.error === 'string') {
      return unavailable('provider_error', { detail: 'ollama_error_field' });
    }
    if (typeof ev.model === 'string') model = ev.model;
    // Choice-mismatch: OpenAI-shaped payload on Ollama chat path is not accepted as Ollama success
    if (Array.isArray(ev.choices)) {
      return unavailable('shape_mismatch', { detail: 'openai_choices_on_ollama_chat' });
    }
    const msg = ev.message;
    if (msg && typeof msg === 'object' && typeof msg.content === 'string') {
      content += msg.content;
    }
    if (ev.done === true) {
      sawDone = true;
      if (typeof ev.done_reason === 'string') doneReason = ev.done_reason;
    }
  }

  // Non-stream single object often includes done:true; stream must end with done.
  if (events.length > 1 && !sawDone) {
    return unavailable('incomplete_stream', { detail: 'missing_done_true' });
  }
  // Final-only chunk: allowed if that chunk has done:true and content (possibly only on earlier chunks)
  if (events.length === 1 && events[0].done === false) {
    return unavailable('incomplete_stream', { detail: 'single_chunk_not_done' });
  }

  if (!isNonEmptyText(content)) {
    return unavailable('empty_content', { doneReason, model });
  }

  // Token bound check if eval_count present and maxTokens set
  const last = events[events.length - 1] || {};
  if (opts.maxTokens != null && typeof last.eval_count === 'number') {
    if (last.eval_count > opts.maxTokens) {
      return unavailable('max_tokens_exceeded', {
        evalCount: last.eval_count,
        maxTokens: opts.maxTokens,
        content: content.trim(),
      });
    }
  }

  return okResult(content, {
    finishReason,
    doneReason: doneReason || (sawDone ? 'stop' : null),
    model,
    evalCount: typeof last.eval_count === 'number' ? last.eval_count : null,
  });
}

/**
 * Parse OpenAI-compatible chat.completions JSON.
 * Success: choices[0].message.content non-whitespace.
 * refusal / empty / missing choice => unavailable.
 */
function parseOpenAIChatBody(bodyText, opts = {}) {
  if (bodyText == null) return unavailable('empty_body');
  let payload;
  try {
    payload = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText;
  } catch {
    return unavailable('parse_error');
  }
  if (!payload || typeof payload !== 'object') return unavailable('parse_error');
  if (typeof payload.error === 'object' || typeof payload.error === 'string') {
    return unavailable('provider_error');
  }
  // Listing payloads must never authorize generation
  if (payload.object === 'list' || (Array.isArray(payload.data) && !Array.isArray(payload.choices))) {
    return unavailable('listing_not_generation', { detail: 'models_list_shape' });
  }
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
    return unavailable('missing_choices');
  }
  const choice = payload.choices[0];
  if (!choice || typeof choice !== 'object') return unavailable('missing_choices');

  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  if (finishReason === 'content_filter') {
    return unavailable('content_filtered', { finishReason });
  }

  const message = choice.message;
  if (!message || typeof message !== 'object') return unavailable('missing_message');

  if (typeof message.refusal === 'string' && message.refusal.trim()) {
    return unavailable('refusal', { finishReason, detail: 'message_refusal' });
  }

  const content = message.content;
  if (!isNonEmptyText(content)) {
    return unavailable('empty_content', { finishReason });
  }

  // Optional usage / max token bound
  const completionTokens =
    payload.usage && typeof payload.usage.completion_tokens === 'number'
      ? payload.usage.completion_tokens
      : null;
  if (opts.maxTokens != null && completionTokens != null && completionTokens > opts.maxTokens) {
    return unavailable('max_tokens_exceeded', {
      completionTokens,
      maxTokens: opts.maxTokens,
      content: content.trim(),
      finishReason,
    });
  }

  return okResult(content, {
    finishReason,
    doneReason: null,
    model: typeof payload.model === 'string' ? payload.model : null,
    completionTokens,
  });
}

/** Gemini native generateContent candidates[0].content.parts[].text */
function parseGeminiNativeBody(bodyText) {
  if (bodyText == null) return unavailable('empty_body');
  let payload;
  try {
    payload = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText;
  } catch {
    return unavailable('parse_error');
  }
  if (!payload || typeof payload !== 'object') return unavailable('parse_error');
  if (payload.error) return unavailable('provider_error');
  const parts =
    payload.candidates &&
    payload.candidates[0] &&
    payload.candidates[0].content &&
    payload.candidates[0].content.parts;
  if (!Array.isArray(parts)) return unavailable('missing_candidates');
  const content = parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  if (!isNonEmptyText(content)) return unavailable('empty_content');
  return okResult(content, { finishReason: null, doneReason: null });
}

/** /api/tags or /models listing — metadata only */
function parseModelsListing(bodyText, kind) {
  if (bodyText == null) return { ok: false, reason: 'empty_body', models: [] };
  let payload;
  try {
    payload = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText;
  } catch {
    return { ok: false, reason: 'parse_error', models: [] };
  }
  if (kind === 'ollama_tags') {
    const models = Array.isArray(payload.models) ? payload.models : [];
    return {
      ok: true,
      reason: null,
      models: models.map((m) => (m && m.name) || null).filter(Boolean),
      generationAuthorized: false,
    };
  }
  // OpenAI-style { data: [ { id } ] }
  const data = Array.isArray(payload.data) ? payload.data : [];
  return {
    ok: true,
    reason: null,
    models: data.map((m) => (m && m.id) || null).filter(Boolean),
    generationAuthorized: false,
  };
}

module.exports = {
  unavailable,
  okResult,
  isNonEmptyText,
  parseOllamaChatBody,
  parseOpenAIChatBody,
  parseGeminiNativeBody,
  parseModelsListing,
};
