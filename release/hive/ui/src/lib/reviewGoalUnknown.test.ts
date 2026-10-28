import {it,expect} from 'vitest'
import {ApiError} from '../api/client'
import {answerLost} from '../store/store'
import {goalWriteResult} from './goalDecision'
import {decisionShown,NOTHING_CHANGED} from './decisionGate'
it('a 500 after a goal update cannot promise nothing changed',()=>{
 const error=new ApiError(500,'internal','failed after updating');
 // Exact store branch at this pin: !answerLost returns a refused GoalWrite.
 const outcome=answerLost(error)?{kind:'unknown' as const,why:error.message}:{kind:'refused' as const,why:error.message};
 const shown=decisionShown(goalWriteResult(outcome,async()=>true));
 expect(JSON.stringify(shown)).not.toContain(NOTHING_CHANGED)
})
