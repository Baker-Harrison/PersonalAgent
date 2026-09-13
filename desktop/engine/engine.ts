import { assignWorkerNames } from '../worker-names.ts';
import { filesTool } from './files-tool.ts';
import { browserTool } from './browser-tool.ts';
import { compactable, summarize } from './context.ts';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ToolLoopAgent, generateText, stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import bash from '../../agent/tools/bash.ts';
import { createPiModel, safeProviderError } from '../../agent/lib/pi-model.ts';
import { createPi, providerId } from '../../agent/lib/pi.ts';
import { reasoningForModel } from '../../agent/lib/reasoning.ts';
import { coordinatorInstructions, collaborationInstructions } from './instructions.ts';
import { EngineDatabase, type Session, type Run } from './database.ts';
import type { Project } from '../store.ts';

export class ProjectEngine {
  readonly events = new EventEmitter();
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private closing = false;
  private observedCalls = new Set<string>();
  private pendingReceipts = new Map<string, { parent: string; data: any }>();
  private suppressedCompletions = new Set<string>();
  constructor(readonly db: EngineDatabase, readonly project: Project, readonly directory: string, readonly workerInstructions: string,
    readonly model: (role: Session['role']) => LanguageModel = role => createPiModel(project[role === 'worker' ? 'worker' : 'coordinator'].model), readonly contextOptions: {budget?:number;summarize?:typeof summarize} = {}) { for(const w of project.workers||[])if(w.displayName&&!db.meta(w.sessionId)?.name)db.setMeta(w.sessionId,{name:w.displayName}); }
  emit(id: string, type: string, data: any = {}, deliveryId?: string) {
    const e = this.db.event(id, type, data, deliveryId); this.events.emit(id, e); return e;
  }
  restore() {
    // A process crash leaves effects uncertain. Never replay a running tool or
    // active turn automatically. Queued, not-yet-started messages are safe to run.
    const interrupted = this.db.db.prepare("SELECT * FROM runs WHERE status='running'").all() as Run[];
    for (const run of interrupted) {
      this.db.runState(run.id, 'interrupted');
      const s = this.db.session(run.session); s.status = 'interrupted';
      const effects = this.db.db.prepare('SELECT name,input,output,status FROM tool_calls WHERE session=? ORDER BY rowid DESC LIMIT 12').all(s.id);
      s.messages.push({ role: 'user', content: 'Runtime recovery: the previous turn was interrupted. Inspect current files and these saved tool records before repeating operations. A running record has an uncertain outcome. ' + JSON.stringify(effects).slice(0,24000) });
      this.db.save(s);
      this.emit(s.id, 'turn.failed', { turnId: run.id, code: 'RUNTIME_INTERRUPTED', message: 'The runtime stopped during this turn. Completed steps are saved. Checking saved progress before continuing.' }, run.id);
      if(!this.db.meta(s.id)?.deleted && !this.db.next(s.id)) this.db.enqueue(s.id,'Continue the interrupted assignment. First reconcile saved effects and current state; do not repeat completed or uncertain actions without checking.',`recover_${run.id}`,'recovery');
    }
    for (const s of this.db.sessions()) this.pump(s.id);
  }
  create(message: string, requestId: string) {
    // Deterministic initial identity makes a retried create safe after lost HTTP acknowledgment.
    const s = this.db.create('coordinator', null, '', `session_${requestId}`);
    this.send(s.id, message, requestId); return s.id;
  }
  send(id: string, message: string, requestId: string, kind = 'user') {
    const session=this.db.session(id);
    if(this.db.meta(id)?.deleted) throw new Error('Agent was deleted.');
    if (this.closing) throw new Error('Runtime is closing.');
    const received = this.db.transaction(() => this.db.enqueue(id, message, requestId, kind)
      ? this.db.event(id, 'message.received', { message, turnId: requestId, sequence: requestId, source: kind }, requestId) : undefined);
    if (received) { this.events.emit(id, received); if (kind==='user' && session.role==='coordinator') this.active.get(id)?.controller.abort(new Error('New user message.')); }
    this.pump(id);
  }
  private pump(id: string) {
    if (this.active.has(id) || this.closing) return;
    const run = this.db.next(id); if (!run) return;
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.run(run, controller)).catch(error => {
      console.error('engine.turn', run.id, safeProviderError(error).message);
    }).finally(() => { this.active.delete(id); this.pump(id); });
    this.active.set(id, { controller, promise });
  }
  private tools(s: Session, runId: string, signal: AbortSignal, executedTools=new Set<string>()): ToolSet {
    const wrap = (name: string, inputSchema: any, description: string, execute: (input: any, callId: string) => unknown) => tool({
      description, inputSchema, execute: async (input, {toolCallId}) => {
        signal.throwIfAborted(); this.db.toolStart(toolCallId, s.id, name, input);
        if(name==='bash')executedTools.add(name);
        try { const result = await execute(input, toolCallId); this.db.toolEnd(toolCallId, result); return result; }
        catch (e) { this.db.toolEnd(toolCallId, { error: e instanceof Error ? e.message : String(e) }); throw e; }
      },
    });
    const journal = (name:string,definition:any) => ({...definition,execute:async(input:any,context:any)=>{
      signal.throwIfAborted();this.db.toolStart(context.toolCallId,s.id,name,input);
      if(['browser','files'].includes(name))executedTools.add(name);
      try{const result=await definition.execute(input,context);this.db.toolEnd(context.toolCallId,JSON.parse(JSON.stringify(result,(key,value)=>key==='image'?'[image saved in file]':value)));return result;}
      catch(error){this.db.toolEnd(context.toolCallId,{error:String(error)});throw error;}
    }});
    const root = s.role==='coordinator' ? s.id : s.parent;
    const owned = (id: string) => { const child=this.db.session(id); if ((child.id!==root && child.parent!==root) || this.db.meta(id)?.deleted) throw new Error('Agent is not available in this project.'); return child; };
    const shared: ToolSet = {
      files: journal('files',filesTool(this.project.folder,files=>this.emit(root!,'result.attached',{files,workerId:s.role==='worker'?s.id:undefined,turnId:runId}))),
      inspect_agents: wrap('inspect_agents', z.object({agentId:z.string().optional(),recentMessages:z.number().int().min(0).max(30).default(0)}), 'Inspect other project agents and optionally their recent conversation.', input => {
        if(input.agentId===s.id)throw new Error('That is your own agent ID. Execute your assignment with your tools; inspecting yourself does not perform the task.');
        return (input.agentId?[owned(input.agentId)]:this.db.sessions().filter(w=>w.id!==s.id&&w.parent===root&&!this.db.meta(w.id)?.deleted)).map(w=>({agentId:w.id,name:this.db.meta(w.id)?.name,task:w.task,status:w.status,queued:!!this.db.next(w.id),messages:input.recentMessages?JSON.parse(JSON.stringify(w.messages.slice(-input.recentMessages),(key,value)=>key==='providerOptions'||key==='providerMetadata'?undefined:(['data','image'].includes(key)&&typeof value==='string'&&value.length>1000?'[image retained]':value))):undefined}));
      }),
      send_to_agent: wrap('send_to_agent', z.object({agentId:z.string(),message:z.string().min(1),delivery:z.enum(['queue','steer']).default('queue')}), 'Message another project agent. Queued messages wake idle recipients; steer interrupts the current turn. Preserve relevant task context.', (input,callId)=>{
        const target=owned(input.agentId); if(target.id===s.id)throw new Error('Choose another agent.');
        if(input.delivery==='steer')this.active.get(target.id)?.controller.abort(new Error('Steered.'));
        this.send(target.id,`From ${this.db.meta(s.id)?.name||s.id}: ${input.message}`,`dispatch_${callId}`,s.role==='worker'?'peer':'coordinator');
        this.emit(root!,'agent.message',{from:s.id,to:target.id,message:input.message});
        return {agentId:target.id,delivered:true};
      }),
      search_conversation: wrap('search_conversation', z.object({query:z.string().default(''),around:z.number().int().optional(),offset:z.number().int().min(0).default(0)}), 'Search original project conversation. Use around with a returned message ID to expand context.', async input=>{
        const history=[...this.db.history(root!),...(s.role==='worker'?this.db.history(s.id):[])].sort((a,b)=>a.id-b.id).map(r=>({...r,message:JSON.stringify(r.message,(key,value)=>key==='providerOptions'||key==='providerMetadata'?undefined:['data','image'].includes(key)&&typeof value==='string'&&value.length>1000?'[image retained]':value).slice(0,6000)}));
        if(input.around){const i=history.findIndex(r=>r.id===input.around);return i<0?[]:history.slice(Math.max(0,i-4),i+5);}
        let terms:string[]=input.query.toLowerCase().match(/[a-z0-9]+/g)||[];
        if(input.query){try{const expansion=await generateText({model:this.model(s.role),prompt:'Return only up to 12 related search keywords for this conversation query: '+input.query,abortSignal:signal});terms=[...new Set([...terms,...(expansion.text.toLowerCase().match(/[a-z0-9]+/g)||[])])];}catch{}}
        return history.map(r=>({ ...r,score:terms.reduce((n,t)=>n+(JSON.stringify(r.message).toLowerCase().includes(t)?1:0),0)})).filter(r=>!terms.length||r.score).sort((a,b)=>b.score-a.score||b.id-a.id).slice(input.offset,input.offset+8);
      }),
    };
    if(s.role==='worker') return {...shared,browser:journal('browser',browserTool(this.directory,this.project.id,s.id,signal)),bash:wrap('bash',bash.inputSchema,bash.description,input=>bash.execute!(input,{session:{id:s.id},abortSignal:signal} as any))};
    const receipt = (child: Session, callId: string, task: string) => {
      const data = { callId, agentId: child.id, childSessionId: child.id, task, name:this.db.meta(child.id)?.name, turnId: runId };
      if (this.observedCalls.has(callId)) this.emit(s.id, 'subagent.called', data);
      else this.pendingReceipts.set(callId, { parent:s.id, data });
      return { agentId: child.id, status: 'working' };
    };
    return {
      ...shared,
      create_agent: wrap('create_agent', z.object({ task: z.string().min(1), name: z.string().optional() }), 'Create a background coding agent for a concrete task. Returns its agentId immediately. Completion notifies you automatically.', (input, callId) => {
        const previous = this.db.sessions().find(w => w.id === `agent_${callId}`);
        if (previous) return receipt(previous, callId, input.task);
        const child = this.db.create('worker', s.id, input.task, `agent_${callId}`);
        const names=this.db.sessions().filter(w=>w.parent===s.id).map(w=>({displayName:this.db.meta(w.id)?.name}));assignWorkerNames([{workers:names}]);
        this.db.setMeta(child.id,{name:input.name||names.at(-1)!.displayName!});
        this.send(child.id, input.task, `dispatch_${callId}`);
        return receipt(child, callId, input.task);
      }),
      cancel_agent: wrap('cancel_agent', z.object({agentId:z.string()}), 'Stop one worker and its queued follow-ups.', input => { owned(input.agentId); this.cancel(input.agentId, false); return {status:'stopping'}; }),
    };
  }
  private async run(run: Run, controller: AbortController) {
    const s = this.db.session(run.session);
    if (run.status !== 'queued' || controller.signal.aborted) return;
    this.db.runState(run.id, 'running'); s.status = 'working';
    const incoming:ModelMessage={role:'user',content:run.prompt}; s.messages.push(incoming); this.db.archive(s.id,[incoming],run.kind); this.db.save(s);
    if(run.kind==='worker')this.emit(s.id,'message.received',{message:run.prompt,turnId:run.id,source:'worker'},run.id);
    this.emit(s.id,'turn.started',{turnId:run.id,sequence:0},run.id);
    let step = -1, block = 0, text = '', finalText = '', failure: unknown;
    let terminal = 'turn.completed', terminalData: any = {};
    const executedTools=new Set<string>();
    const coordinates = () => ({turnId:run.id,sequence:block,stepIndex:step});
    try {
      const selection = this.project[s.role === 'worker' ? 'worker' : 'coordinator'];
      const selected = createPi().getModel(providerId,selection.model)!;
      const system = (s.role === 'worker' ? this.workerInstructions+'\n'+collaborationInstructions : coordinatorInstructions)
        +`\nYour agent ID is ${s.id}. Your role is ${s.role}.`
        +(s.role==='worker'?` You are responsible for executing this assignment yourself: ${s.task}. Other agents are collaborators; your own entry in the agent list is not another worker doing your task.`:'');
      const agent = new ToolLoopAgent({ model:this.model(s.role), instructions:system, tools:this.tools(s,run.id,controller.signal,executedTools),
        providerOptions:{pi:{reasoningEffort:reasoningForModel(selected,selection.reasoning)}},
        timeout:{firstChunkMs:60_000,chunkMs:60_000}, maxRetries:0, stopWhen:stepCountIs(100),
        onStepEnd: event => { s.messages.push(...event.response.messages); this.db.archive(s.id,event.response.messages,s.role); this.db.save(s); },
        prepareStep: async()=>{
          const split=compactable(s.messages,this.contextOptions.budget??Math.floor(selected.contextWindow*.65),system.length+12000);
          if(split){
            this.emit(s.id,'context.compacting',{turnId:run.id});
            try{
              const summary=await (this.contextOptions.summarize??summarize)(this.model(s.role),s.messages.slice(0,split),controller.signal);
              controller.signal.throwIfAborted();
              s.messages=[{role:'user',content:'Earlier conversation summary. Original archive through message '+this.db.history(s.id).at(-1)?.id+'. Use search_conversation for details:\n'+summary},...s.messages.slice(split)];
              this.db.save(s); this.emit(s.id,'context.compacted',{turnId:run.id});
            }catch(error){this.emit(s.id,'context.failed',{turnId:run.id,message:'Could not organize the conversation. Try again.'});throw error;}
          }
          return {messages:s.messages,system:system+'\nCurrent agents: '+JSON.stringify(this.db.sessions().filter(w=>w.parent===(s.role==='coordinator'?s.id:s.parent)&&!this.db.meta(w.id)?.deleted).map(w=>({id:w.id,name:this.db.meta(w.id)?.name,task:w.task,status:w.status}))) }; },
      });
      const result = await agent.stream({messages:s.messages,abortSignal:controller.signal});
      for await (const part of result.fullStream) {
        const c = coordinates();
        switch (part.type) {
          case 'start-step': step++; this.emit(s.id,'step.started',{...coordinates(),modelId:selection.model},run.id); break;
          case 'text-start': block++; text=''; break;
          case 'text-delta': text+=part.text; this.emit(s.id,'message.appended',{...coordinates(),messageDelta:part.text},run.id); break;
          case 'text-end': finalText=text; this.emit(s.id,'message.completed',{...coordinates(),message:text,finishReason:'stop'},run.id); break;
          case 'tool-input-start': this.emit(s.id,'action.input.appended',{...c,callId:part.id,toolName:part.toolName,inputTextDelta:''},run.id); break;
          case 'tool-input-delta': this.emit(s.id,'action.input.appended',{...c,callId:part.id,inputTextDelta:part.delta},run.id); break;
          case 'tool-call': {
            this.emit(s.id,'actions.requested',{...c,actions:[{kind:'tool-call',callId:part.toolCallId,toolName:part.toolName,input:part.input}]},run.id);
            this.observedCalls.add(part.toolCallId);
            const receipt=this.pendingReceipts.get(part.toolCallId);
            if(receipt){this.emit(receipt.parent,'subagent.called',receipt.data);this.pendingReceipts.delete(part.toolCallId);} break;
          }
          case 'tool-result': this.emit(s.id,'action.result',{...c,status:'completed',result:{kind:'tool-result',callId:part.toolCallId,toolName:part.toolName,output:part.output}},run.id); break;
          case 'tool-error': this.emit(s.id,'action.result',{...c,status:'failed',result:{kind:'tool-result',callId:part.toolCallId,toolName:part.toolName,isError:true,output:String(part.error)}},run.id); break;
          case 'finish-step': this.emit(s.id,'step.completed',{...c,finishReason:part.finishReason},run.id); break;
          case 'reasoning-delta': this.emit(s.id,'reasoning.appended',{...c,reasoningDelta:part.text},run.id); break;
          case 'error': failure=part.error; break;
        }
      }
      if (failure) throw failure;
      controller.signal.throwIfAborted();
      if (await result.finishReason === 'tool-calls') throw new Error('The agent reached its step limit. Send a follow-up to continue.');
      s.status='done';
    } catch(e) {
      const stopped=controller.signal.aborted;
      if(stopped){
        if(text.trim()&&!JSON.stringify(s.messages.at(-1)).includes(text.trim())){const partial:ModelMessage={role:'assistant',content:text};s.messages.push(partial);this.db.archive(s.id,[partial],s.role);}
        const effects=this.db.db.prepare('SELECT name,input,output,status FROM tool_calls WHERE session=? ORDER BY rowid DESC LIMIT 8').all(s.id);
        if(effects.length)s.messages.push({role:'user',content:'Turn interrupted. These recent tool records may include completed or uncertain effects; inspect state before repeating actions: '+JSON.stringify(effects).slice(0,20000)});
      }
      s.status=stopped?'stopped':'failed';
      finalText=stopped?'The worker was stopped. Completed steps remain saved.':safeProviderError(e).message;
      terminal=stopped?'turn.cancelled':'turn.failed'; terminalData=stopped?{}:{code:'MODEL_CALL_FAILED',message:finalText};
    } finally {
      const notify = s.parent && !this.db.meta(s.id)?.deleted && !this.closing && !this.suppressedCompletions.has(run.id) && !this.db.next(s.id);
      // Final state, terminal events, and the coordinator wake-up are one commit.
      const committed = this.db.transaction(() => {
        this.db.save(s); this.db.runState(run.id,s.status==='done'?'completed':s.status);
        const terminalEvent=this.db.event(s.id,terminal,{...coordinates(),...terminalData},run.id);
        const waiting=this.db.event(s.id,'session.waiting',{wait:'next-user-message'},run.id);
        if(notify) this.db.enqueue(s.parent!,`Agent ${s.id} finished with status ${s.status}.\nTask: ${s.task}\nResult:\n${finalText}\nExecution evidence: ${executedTools.size?'This turn used '+[...executedTools].join(', ')+'. Inspect results before asserting success.':'No Bash, browser, or file tools ran in this turn. Treat claims about executed commands or verified files as unverified; request the missing execution if the assignment requires it.'}`,`completion_${run.id}`,'worker');
        return [terminalEvent,waiting];
      });
      for(const event of committed)this.events.emit(s.id,event);
      if(notify)this.pump(s.parent!);
    }
  }
  manageWorker(id:string, action:'rename'|'delete', name?:string) {
    const s=this.db.session(id);if(s.role!=='worker')throw new Error('Choose a worker.');
    if(action==='rename') { if(!name?.trim()||name.length>60)throw new Error('Enter a name under 60 characters.');this.db.setMeta(id,{name:name.trim()}); }
    else {
      const unfinished=this.active.has(id)||!!this.db.next(id)||!['done','stopped','failed'].includes(s.status);
      this.db.setMeta(id,{deleted:1});this.cancel(id,false);
      if(s.parent&&unfinished)this.send(s.parent,`The user deleted agent ${id} and cancelled its assignment: ${s.task}. Do not recreate it. Only report if this affects other unfinished work or requires a user decision. Otherwise leave the cancelled assignment dropped.`,`delete_${id}`,'management');
    }
    if(s.parent)this.emit(s.parent,'agent.updated',{agentId:id,...this.db.meta(id)});
  }
  cancel(id: string, children = true) {
    const ids=[id,...(children?this.db.sessions().filter(s=>s.parent===id).map(s=>s.id):[])];
    let active=false;
    if(children) for(const target of ids) for(const row of this.db.db.prepare("SELECT id FROM runs WHERE session=? AND status='running'").all(target) as {id:string}[]) this.suppressedCompletions.add(row.id);
    for(const target of ids) {
      this.db.db.prepare("UPDATE runs SET status='cancelled' WHERE session=? AND status='queued'").run(target);
      const entry=this.active.get(target); if(entry){active=true;entry.controller.abort(new Error('Stopped by user.'));}
    }
    return active;
  }
  async shutdown() { this.closing=true; for(const entry of this.active.values())entry.controller.abort(); await Promise.allSettled([...this.active.values()].map(e=>e.promise)); this.db.close(); }
}
