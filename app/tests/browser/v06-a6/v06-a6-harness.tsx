// A6 browser harness: drive the real TimelineJournalV06 against the in-memory
// test adapter (synthetic dial with sleep + breakfast, one reflection, a
// migrated legacy block; no IndexedDB/personal data/real files). The session is
// exposed on window so the walkthrough can place/move/retract breakfast and
// inject file states, then observe the projected timeline.
import {createRoot} from 'react-dom/client';
import {createJournalTestSession} from '../../support/v06/journal-test-session.ts';
import {TimelineJournalV06} from '../../../src/journal/ui/TimelineJournalV06.tsx';

const session = createJournalTestSession();
Object.assign(window, {session});

function Harness() {
  return (
    <div className="app paper comfortable">
      <main style={{paddingTop: 16}}>
        <h1 style={{fontSize: 18, color: '#2c4239'}}>A6 时间线日记走查（测试适配器）</h1>
        <TimelineJournalV06 session={session} />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
