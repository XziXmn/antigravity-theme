/**
 * core/daemon/protobuf.mjs — Zero-Dependency Wire Protobuf & Step Metadata Parser
 */
export function parseProto(buf) {
  let i = 0;
  const out = new Map();
  while (i < buf.length) {
    let tag = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn <= 0 || fn > 10000) break;
    if (wt === 0) {
      let val = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        val += (b & 0x7f) * Math.pow(2, s);
        if (!(b & 0x80)) break;
        s += 7;
      }
      out.set(fn, val);
    } else if (wt === 2) {
      let len = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      if (len < 0 || i + len > buf.length) break;
      out.set(fn, buf.subarray(i, i + len));
      i += len;
    } else if (wt === 1) {
      if (i + 8 > buf.length) break;
      out.set(fn, buf.subarray(i, i + 8));
      i += 8;
    } else if (wt === 5) {
      if (i + 4 > buf.length) break;
      out.set(fn, buf.subarray(i, i + 4));
      i += 4;
    } else {
      break;
    }
  }
  return out;
}

export function parseProtoMulti(buf) {
  const out = new Map();
  if (!buf || !buf.length) return out;
  let i = 0;
  while (i < buf.length) {
    let tag = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn <= 0 || fn > 10000) break;
    let val;
    if (wt === 0) {
      let v = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        v += (b & 0x7f) * Math.pow(2, s);
        if (!(b & 0x80)) break;
        s += 7;
      }
      val = v;
    } else if (wt === 2) {
      let len = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      if (len < 0 || i + len > buf.length) break;
      val = buf.subarray(i, i + len);
      i += len;
    } else if (wt === 1) {
      if (i + 8 > buf.length) break;
      val = buf.subarray(i, i + 8);
      i += 8;
    } else if (wt === 5) {
      if (i + 4 > buf.length) break;
      val = buf.subarray(i, i + 4);
      i += 4;
    } else {
      break;
    }
    if (!out.has(fn)) out.set(fn, []);
    out.get(fn).push(val);
  }
  return out;
}

export function extractMaxStepIdx(raw) {
  if (typeof raw === 'number') return raw >= 0 ? raw : -1;
  if (!raw || typeof raw.length !== 'number' || raw.length === 0) return -1;
  let i = 0;
  let maxVal = -1;
  while (i < raw.length) {
    let val = 0;
    let s = 0;
    while (i < raw.length) {
      const b = raw[i++];
      val += (b & 0x7f) * Math.pow(2, s);
      if (!(b & 0x80)) break;
      s += 7;
    }
    if (val > maxVal) maxVal = val;
  }
  return maxVal;
}

export function formatDisplayModelName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s
    .replace(/\(\s*(?:x[\s_-]*high|extra[\s_-]*high)\s*\)/gi, '(Extra High)')
    .replace(/\bx[\s_-]*high\b/gi, 'Extra High');
}

export function parseGenMetadataRow(r) {
  const top = parseProto(r.data);
  const chat = top.has(1) ? parseProto(top.get(1)) : new Map();
  const usage = chat.has(4) ? parseProto(chat.get(4)) : new Map();
  const chatStart = chat.has(9) ? parseProto(chat.get(9)) : new Map();
  const ctxMeta = chatStart.has(10) ? parseProto(chatStart.get(10)) : new Map();
  const ttftMap = chat.has(11) ? parseProto(chat.get(11)) : new Map();
  const streamMap = chat.has(12) ? parseProto(chat.get(12)) : new Map();
  const planner = top.has(3) ? parseProto(top.get(3)) : new Map();
  const planExec = planner.has(60) ? parseProto(planner.get(60)) : null;

  const inTok = usage.get(2) || 0;
  const outTok = usage.get(3) || 0;
  const cacheWrite = usage.get(4) || 0;
  const cacheRead = usage.get(5) || 0;
  const ctxUsed = ctxMeta.get(1) || 0;
  const maxCtx = ctxMeta.get(4) || 0;
  const maxStepIdx = extractMaxStepIdx(top.get(2));
  const thinkTok = usage.get(9) || 0;
  const respTok = usage.get(10) || 0;
  const modelEnum = chat.get(3) || 0;
  const executionModelEnum = planExec ? planExec.get(1) || 0 : 0;
  const role = executionModelEnum ? (modelEnum === executionModelEnum ? 'execution' : 'planner') : '';

  const ctxCategories = [];
  if (ctxMeta.has(3)) {
    const bdMulti = parseProtoMulti(ctxMeta.get(3));
    const rawGroups = bdMulti.get(1) || [];
    const isBytes = (v) => v instanceof Uint8Array || Buffer.isBuffer(v);
    for (let gi = 0; gi < rawGroups.length; gi++) {
      const gBuf = rawGroups[gi];
      if (!isBytes(gBuf)) continue;
      const gMulti = parseProtoMulti(gBuf);
      const labelBuf = gMulti.get(1)?.[0];
      const label = isBytes(labelBuf) ? Buffer.from(labelBuf).toString('utf8').trim() : '';
      const tokens = Number(gMulti.get(4)?.[0] || 0);
      if (!label || tokens <= 0) continue;
      let skillsTok = 0;
      const children = gMulti.get(5) || [];
      if (label === 'System Prompt' && children.length > 0) {
        for (const cBuf of children) {
          if (!isBytes(cBuf)) continue;
          const cMap = parseProto(cBuf);
          const cLabel = cMap.has(1) && isBytes(cMap.get(1)) ? Buffer.from(cMap.get(1)).toString('utf8').trim() : '';
          if (cLabel === 'skills') {
            skillsTok = Number(cMap.get(3) || 0);
            break;
          }
        }
      }
      if (skillsTok > 0) {
        if (tokens - skillsTok > 0) {
          ctxCategories.push({ key: `group-${gi}`, label, tokens: tokens - skillsTok });
        }
        ctxCategories.push({ key: 'skills', label: 'Skills', tokens: skillsTok });
      } else {
        ctxCategories.push({ key: `group-${gi}`, label, tokens });
      }
    }
  }

  const ttft = (ttftMap.get(1) || 0) + (ttftMap.get(2) || 0) / 1e9;
  const stream = (streamMap.get(1) || 0) + (streamMap.get(2) || 0) / 1e9;
  const rawModelName =
    (chat.has(21) ? Buffer.from(chat.get(21)).toString('utf8').trim() : '') ||
    (chat.has(19) ? Buffer.from(chat.get(19)).toString('utf8').trim() : '') ||
    (planner.has(28) ? Buffer.from(planner.get(28)).toString('utf8').trim() : '');
  const modelName = formatDisplayModelName(rawModelName);
  const meta17 = chat.has(17) ? parseProto(chat.get(17)) : null;
  const errCode = meta17 && meta17.has(5) ? meta17.get(5) : 0;
  const errMsg = meta17 && meta17.has(3) ? Buffer.from(meta17.get(3)).toString('utf8').trim() : '';

  return {
    idx: r.idx,
    inTok,
    outTok,
    cacheWrite,
    cacheRead,
    ctx: inTok + cacheWrite + cacheRead,
    ctxUsed,
    maxCtx,
    ctxCategories,
    maxStepIdx,
    modelName,
    modelEnum,
    executionModelEnum,
    role,
    thinkTok,
    respTok,
    ttft,
    stream,
    totDur: ttft + stream,
    errCode,
    errMsg
  };
}

export function parseCheckpointStepInfo(row) {
  if (!row) return null;
  let cpMetaIdx = -1;
  if (row.metadata) {
    const meta = parseProto(row.metadata);
    const stepInfo = meta.has(20) ? parseProto(meta.get(20)) : null;
    const rawMIdx = stepInfo && stepInfo.get(3);
    if (typeof rawMIdx === 'number') {
      cpMetaIdx = rawMIdx;
    }
  }
  let summaryBytes = 0;
  let summaryTokens = 0;
  if (row.step_payload) {
    const top = parseProto(row.step_payload);
    const cpBody = top.has(30) ? parseProto(top.get(30)) : null;
    const summaryBuf = cpBody && cpBody.get(5);
    if (summaryBuf && typeof summaryBuf.length === 'number') {
      summaryBytes = summaryBuf.length;
      const str = Buffer.from(summaryBuf).toString('utf8');
      let cjk = 0;
      for (let k = 0; k < str.length; k++) {
        const ch = str.charCodeAt(k);
        if ((ch >= 0x4e00 && ch <= 0x9fff) || (ch >= 0x3400 && ch <= 0x4dbf)) cjk++;
      }
      const other = str.length - cjk;
      const cpMulti = parseProtoMulti(top.get(30));
      const artCount = Math.min((cpMulti.get(14) || []).length, 200);
      const est = Math.ceil(cjk * 1.15 + other / 3.8) + artCount * 35;
      summaryTokens = est > 0 ? Math.max(500, est) : 0;
    }
  }
  return {
    idx: row.idx,
    status: row.status,
    cpMetaIdx,
    summaryBytes,
    summaryTokens
  };
}

export function extractStepTimestampParts(metaBuf) {
  if (!metaBuf) return { sec: 0, nanos: 0 };
  const meta = parseProto(metaBuf);
  const ts = meta.has(1) ? parseProto(meta.get(1)) : null;
  if (!ts) return { sec: 0, nanos: 0 };
  return { sec: ts.get(1) || 0, nanos: ts.get(2) || 0 };
}

export function extractStepStartMs(metaBuf) {
  const { sec, nanos } = extractStepTimestampParts(metaBuf);
  return sec > 0 ? sec * 1000 + Math.floor(nanos / 1e6) : 0;
}

export function extractUserStepSig(stepIdx, row) {
  if (stepIdx < 0 || !row) return '';
  const { sec, nanos } = extractStepTimestampParts(row.metadata);
  return `${stepIdx}:${sec}.${nanos}:${row.plen || 0}`;
}

export function isCancelText(msg) {
  return /(\bcontext\s+canceled\b|\bcancell?ed\s+by\s+user\b|\baborted\s+by\s+user\b|\buser\s+cancell?ed\b)/i.test(
    String(msg || '').trim()
  );
}

/**
 * Recursively decode clean UTF-8 leaf strings inside protobuf wire payloads BEFORE descending,
 * avoiding misinterpreted printable ASCII inside error strings as protobuf tags/varints.
 */
export function extractProtoLeafStrings(buf, depth = 0, out = []) {
  if (!buf || !buf.length || depth > 5) return out;
  if (buf.length >= 6) {
    try {
      const dec = new TextDecoder('utf-8', { fatal: true });
      const s = dec.decode(buf).trim();
      if (s && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s) && !/^[0-9a-f-]{32,}(?:-\d+)*$/i.test(s)) {
        out.push(s);
        return out;
      }
    } catch {}
  }
  const fields = parseProto(buf);
  for (const [, val] of fields.entries()) {
    if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
      extractProtoLeafStrings(val, depth + 1, out);
    }
  }
  return out;
}

function readTsMs(meta, fieldNo) {
  const buf = meta.get(fieldNo);
  if (!(buf instanceof Uint8Array || Buffer.isBuffer(buf))) return 0;
  const ts = parseProto(buf);
  const sec = ts.get(1) || 0;
  const nanos = ts.get(2) || 0;
  return sec > 0 ? sec * 1000 + Math.floor(nanos / 1e6) : 0;
}

export function extractStepTimingMs(metaBuf) {
  if (!metaBuf) return { createdMs: 0, startedMs: 0, completedMs: 0 };
  const meta = parseProto(metaBuf);
  return {
    createdMs: readTsMs(meta, 1),
    startedMs: readTsMs(meta, 32),
    completedMs: readTsMs(meta, 8) || readTsMs(meta, 7)
  };
}

export function parseStepToolSummary(row) {
  if (!row) return null;
  const { createdMs, startedMs, completedMs } = extractStepTimingMs(row.metadata);
  const strs = [];
  if (row.metadata) extractProtoLeafStrings(row.metadata, 0, strs);
  // Look for call_<id>, toolName, JSON args
  let toolName = '';
  let argsObj = null;
  for (let i = 0; i < strs.length; i++) {
    const s = strs[i];
    if (/^[a-z][a-z0-9_]{1,40}$/i.test(s) && !toolName && i > 0 && /^call_/i.test(strs[i - 1])) {
      toolName = s;
    } else if (!toolName && /^(?:run_command|read_file|write_file|edit_file|search_web|find_by_name|grep_search|list_dir|multi_replace_file_content|replace_file_content|view_file|command_status|send_command_input|invoke_subagent|schedule)$/i.test(s)) {
      toolName = s;
    }
    if (!argsObj && s.startsWith('{') && s.endsWith('}')) {
      try {
        argsObj = JSON.parse(s);
      } catch {}
    }
  }
  if (!toolName && !argsObj) return null;
  const pathStr = String(argsObj?.Path || argsObj?.AbsolutePath || argsObj?.TargetFile || argsObj?.DirectoryPath || '');
  const baseFile = pathStr ? pathStr.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '' : '';
  const summary = String(argsObj?.toolSummary || '').trim();
  const cmd = String(argsObj?.CommandLine || '').trim();
  let label = toolName || '工具调用';
  let detail = cmd || pathStr || '';
  if (summary) label = summary;
  else if (/^(?:read_file|view_file)$/i.test(toolName) && baseFile) label = `读取 ${baseFile}`;
  else if (/^(?:write_file|edit_file|replace_file_content|multi_replace_file_content)$/i.test(toolName) && baseFile) label = `修改 ${baseFile}`;
  else if (/^run_command$/i.test(toolName) && cmd) label = `执行 ${cmd.slice(0, 36)}`;
  else if (/^search_web$/i.test(toolName) && argsObj?.query) label = `搜索 ${String(argsObj.query).slice(0, 30)}`;
  else if (baseFile) label = `${toolName}: ${baseFile}`;

  const st = Number(row.status || 0);
  const status = st === 1 || st === 2 ? 'running' : 'complete';
  const beginMs = startedMs || createdMs;
  const durationMs = completedMs && beginMs && completedMs >= beginMs ? completedMs - beginMs : null;
  return {
    id: `step-${row.idx}`,
    idx: row.idx,
    toolName: toolName || 'tool',
    label,
    detail,
    startedAtMs: beginMs || null,
    durationMs,
    status
  };
}

export function extractStep17Message(row) {
  if (!row) return '';
  const protoStrings = [];
  if (row.step_payload) extractProtoLeafStrings(Buffer.from(row.step_payload), 0, protoStrings);
  if (row.error_details) extractProtoLeafStrings(Buffer.from(row.error_details), 0, protoStrings);
  for (let i = protoStrings.length - 1; i >= 0; i--) {
    if (/(?:API error|request failed|stream|timeout|EOF|tls:|bad record|unavailable|503|429|ECONN|canceled|cancelled)/i.test(protoStrings[i])) {
      return protoStrings[i].slice(0, 200);
    }
  }
  if (protoStrings.length > 0) {
    return protoStrings[protoStrings.length - 1].slice(0, 200);
  }
  const chunks = [];
  if (row.step_payload) chunks.push(Buffer.from(row.step_payload).toString('utf8'));
  if (row.error_details) chunks.push(Buffer.from(row.error_details).toString('utf8'));
  const cleaned = chunks
    .join('\n')
    .replace(/[^\x20-\x7e\u4e00-\u9fff\n]+/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length >= 6 && !/^[0-9a-f-]{32,}(?:-\d+)*$/i.test(s));
  for (let i = cleaned.length - 1; i >= 0; i--) {
    if (/(?:API error|request failed|stream|timeout|EOF|tls:|bad record|unavailable|503|429|ECONN)/i.test(cleaned[i])) {
      return cleaned[i].slice(0, 200);
    }
  }
  return cleaned.length > 0 ? cleaned[cleaned.length - 1].slice(0, 200) : '';
}
