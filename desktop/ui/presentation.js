export const toolNames = {
  create_agent: 'Delegating task', send_to_agent: 'Sending follow-up', get_agent_status: 'Checking progress',
  read_agent_transcript: 'Reading task update', cancel_agent: 'Stopping task', project_notes: 'Project notes', bash: 'Running command',
};
export const busyStates = ['working', 'disconnected', 'blocked', 'compacting'];
export function activitySummary(p) {
  if (!p) return '';
  if (p.status === 'stop-failed') return 'Stop not confirmed. Ask to stop again';
  if (p.connection === 'offline') return 'Disconnected. Send a message to reconnect';
  if (p.connection === 'reconnecting' || p.workers.some(w => w.status === 'disconnected')) return 'Reconnecting to activity';
  if (p.status === 'blocked' || p.workers.some(w => w.status === 'blocked')) return 'Your attention is needed';
  if (p.status === 'stopping') return 'Stopping…';
  if (p.status === 'starting') return 'Connecting…';
  const active = p.workers.find(w => w.status === 'working');
  if (active) return active.name || active.task || 'Working on your request';
  const call = (p.activity || []).findLast(a => ['running', 'preparing'].includes(a.status));
  if (call && p.status !== 'idle') return toolNames[call.name] || call.name;
  if (p.status === 'compacting') return 'Organizing conversation…';
  if (p.status === 'thinking') return 'Working on your reply';
  if (p.workers.at(-1)?.status === 'failed' || p.activity?.at(-1)?.status === 'failed' || p.messages.at(-1)?.role === 'error') return 'Something needs attention';
  if (p.workers.at(-1)?.status === 'stopped') return 'Work stopped · View activity';
  if (p.workers.length || p.activity?.length) return 'View activity';
  return '';
}
export function isBusy(p) {
  return !!p && (p.status !== 'idle' || p.workers.some(w => busyStates.includes(w.status)));
}
export function blocks(text) {
  // Keep paragraph identity stable as text streams; unfinished fences stay code.
  const result = []; let paragraph = [], code = null, language = '';
  const flush = () => { if (paragraph.length) result.push({ type: 'text', text: paragraph.join('\n') }); paragraph = []; };
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (code !== null) { result.push({ type: 'code', text: code.join('\n'), language }); code = null; }
      else { flush(); language = line.trim().slice(3).trim(); code = []; }
    } else if (code !== null) code.push(line);
    else if (!line.trim()) flush();
    else paragraph.push(line);
  }
  if (code !== null) result.push({ type: 'code', text: code.join('\n'), language });
  flush(); return result;
}

export function workerStatus(w) {
  return { working: 'Working', compacting: 'Organizing conversation', done: 'Completed', failed: 'Needs attention', stopped: 'Stopped', disconnected: 'Reconnecting', blocked: 'Needs your input' }[w.status] || w.status;
}
export function currentAction(owner) {
  const call = (owner.activity || []).findLast(a => ['running', 'preparing'].includes(a.status));
  if (call) {
    let input; try { input = JSON.parse(call.input || '{}'); } catch {}
    if (call.name === 'bash' && input?.command) return `Running ${input.command.replace(/\s+/g, ' ').slice(0, 110)}`;
    return toolNames[call.name] || call.name;
  }
  return '';
}
export function workerAction(w) {
  if (w.status !== 'working') return workerStatus(w);
  return currentAction(w) || w.updates?.findLast(u => u.kind !== 'steering')?.text?.replace(/\s+/g, ' ').slice(0, 140) || w.name || w.task || 'Working on your request';
}
export function progressState(p) {
  if (!p) return { text: '', spinning: false };
  if (p.status === 'stop-failed' || p.connection === 'offline' || p.connection === 'reconnecting' || p.status === 'blocked' || p.workers.some(w => ['blocked', 'disconnected'].includes(w.status))) return { text: activitySummary(p), spinning: p.connection === 'reconnecting' };
  if (p.status === 'starting' || p.status === 'stopping') return { text: activitySummary(p), spinning: true };
  if (p.status === 'compacting') return {text:'Organizing conversation…',spinning:true};
  if (p.status === 'thinking') return { text: currentAction(p) || 'Thinking…', spinning: true };
  const active = p.workers.filter(w => ['working','compacting'].includes(w.status));
  if (active.length) return { text: active.length === 1 ? `${active[0].displayName || 'Worker'} · ${workerAction(active[0])}` : `${active.length} agents working`, spinning: true };
  if (p.messages.at(-1)?.role === 'error' || p.workers.at(-1)?.status === 'failed' || p.activity?.at(-1)?.status === 'failed') return { text: 'Something needs attention', spinning: false };
  return { text: '', spinning: false };
}
