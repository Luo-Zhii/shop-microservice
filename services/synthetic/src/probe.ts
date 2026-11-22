import { counter, gauge, histogram } from '@shopnow/platform';
import { STEP_SERVICE, runJourney, type JourneyOptions, type JourneyResult, type StepName } from './journey';

const stepDuration = () => histogram('synthetic_step_duration_seconds', 'Thời gian từng bước hành trình tổng hợp',
  ['journey', 'step', 'service', 'location'], [0.05, 0.1, 0.25, 0.5, 1, 2, 5]);
const stepSuccess = () => gauge('synthetic_step_success', '1 = bước gần nhất thành công, 0 = hỏng (bước không chạy tới bị bỏ nhãn)',
  ['journey', 'step', 'service', 'location']);
const journeySuccess = () => gauge('synthetic_journey_success', '1 = cả hành trình thành công ở lần chạy gần nhất', ['journey', 'location']);
const runs = () => counter('synthetic_journey_runs_total', 'Số lần chạy hành trình tổng hợp', ['journey', 'location', 'result']);
const lastRun = () => gauge('synthetic_last_run_timestamp_seconds', 'Thời điểm chạy gần nhất (phát hiện robot chết)', ['journey', 'location']);

/** Chạy một lần + ghi metric; giữ `keep` kết quả gần nhất cho /results. */
export function createProbe(opts: JourneyOptions, keep = 20) {
  const history: JourneyResult[] = [];
  return {
    history,
    async runOnce(): Promise<JourneyResult> {
      const r = await runJourney(opts);
      const ran = new Set(r.steps.map((s) => s.step));
      for (const s of r.steps) {
        const l = { journey: r.journey, step: s.step, service: s.service, location: r.location };
        stepDuration().observe(l, s.ms / 1000);
        stepSuccess().set(l, s.ok ? 1 : 0);
      }
      for (const step of Object.keys(STEP_SERVICE) as StepName[]) {
        if (!ran.has(step)) stepSuccess().remove({ journey: r.journey, step, service: STEP_SERVICE[step], location: r.location });
      }
      journeySuccess().set({ journey: r.journey, location: r.location }, r.ok ? 1 : 0);
      runs().inc({ journey: r.journey, location: r.location, result: r.ok ? 'success' : 'failure' });
      lastRun().set({ journey: r.journey, location: r.location }, Date.now() / 1000);
      history.unshift(r);
      history.length = Math.min(history.length, keep);
      return r;
    },
  };
}
