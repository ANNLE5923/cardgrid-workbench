import { displayInstant, elapsedMinutes } from '../time.ts';
import type { DialItem, DialSource } from './types.ts';

const KIND_LABEL: Record<DialSource, string> = {
  plan: '计划',
  fixed: '固定',
  fact: '事实',
  'plan-reference': '原计划轮廓',
  empty: '空时间',
  legacy: '旧来源',
  'projected-readonly': '只读预览',
};

const pad = (n: number) => String(n).padStart(2, '0');
export const clockLabel = (unit: number) =>
  `${pad(Math.floor(unit / 60))}:${pad(unit % 60)}`;

/**
 * Read-only overview. Duration and endpoints come from the source's FULL range
 * (with record zone/offset), not a wall-clock bounding box; cross-day continuation
 * and a display-zone conversion are shown. Actual and reference are separate items.
 */
export function DayOverview(props: Readonly<{
  title: string;
  date: string;
  zone: string;
  items: readonly DialItem[];
  onClose: () => void;
}>) {
  const { title, date, zone, items, onClose } = props;
  return (
    <div className="preview-note" role="dialog" aria-label={`${title} 日程概述`}>
      <div className="preview-note-heading">
        <strong>{title} · 日程概述</strong>
        <button type="button" onClick={onClose} aria-label="关闭日程概述">×</button>
      </div>
      {items.length ? (
        items.map(item => {
          const full = item.range;
          let fullLine: string | null = null;
          let displayLine: string | null = null;
          let continuation: string | null = null;
          if (full) {
            const rs = displayInstant(full.startAt, full.zone);
            const re = displayInstant(full.endAt, full.zone);
            fullLine = `完整 ${rs.date} ${rs.time} ${rs.offset} — ${re.date} ${re.time} ${re.offset} · ${elapsedMinutes(full)} 分钟`;
            if (full.zone !== zone) {
              const ds = displayInstant(full.startAt, zone);
              const de = displayInstant(full.endAt, zone);
              displayLine = `按 ${zone} 显示：${ds.date} ${ds.time} — ${de.date} ${de.time}`;
            }
            const before = displayInstant(full.startAt, zone).date < date;
            const after = displayInstant(full.endAt, zone).date > date;
            continuation = before || after
              ? `${before ? '续前一日 ' : ''}${after ? '→ 次日延续' : ''}`
              : null;
          }
          return (
            <div key={JSON.stringify([item.source, item.id])} className="preview-note-item">
              <span className={`time-kind ${item.source}`}>{KIND_LABEL[item.source]}</span>
              <strong>{item.title}</strong>
              {fullLine ? <small>{fullLine}</small> : (
                <small>
                  {clockLabel(item.startMinute)}—{clockLabel(item.endMinute)} ·{' '}
                  {item.endMinute - item.startMinute} 分钟
                </small>
              )}
              {displayLine ? <small>{displayLine}</small> : null}
              {continuation ? <small>{continuation}</small> : null}
              {item.readOnly ? <small>只读，不能编辑</small> : null}
            </div>
          );
        })
      ) : (
        <p>这一刻没有日程。</p>
      )}
    </div>
  );
}
