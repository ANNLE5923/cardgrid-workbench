import { useMemo } from 'react';
import { Temporal } from '@js-temporal/polyfill';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

type Props = Readonly<{
  year: number;
  month: number;
  selectedDate: string;
  today: string;
  datesWithEntry: ReadonlySet<string>;
  onSelect: (date: string) => void;
}>;

/** Compact 6-week (42-cell) month grid; weeks start Monday. Future dates are disabled. */
export function JournalMonthCalendar({
  year,
  month,
  selectedDate,
  today,
  datesWithEntry,
  onSelect,
}: Props) {
  const grid = useMemo(() => {
    const first = Temporal.PlainDate.from({ year, month, day: 1 });
    const offset = (first.dayOfWeek + 6) % 7; // Monday → 0
    const start = first.subtract({ days: offset });
    return Array.from({ length: 42 }, (_, i) => start.add({ days: i }));
  }, [year, month]);

  return (
    <div className="journal-calendar">
      <div className="journal-calendar-weekdays">
        {WEEKDAYS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="journal-calendar-grid">
        {grid.map((day) => {
          const ymd = day.toString();
          const sameMonth = day.month === month && day.year === year;
          const classes = ['journal-calendar-cell'];
          if (!sameMonth) classes.push('is-outside');
          if (ymd === today) classes.push('is-today');
          if (ymd === selectedDate) classes.push('is-selected');
          const hasEntry = datesWithEntry.has(ymd);
          if (hasEntry) classes.push('has-entry');
          const isFuture = ymd > today;
          if (isFuture) classes.push('is-future');
          return (
            <button
              key={ymd}
              type="button"
              className={classes.join(' ')}
              disabled={isFuture}
              title={ymd}
              onClick={() => onSelect(ymd)}
            >
              {day.day}
              {hasEntry && <span className="journal-calendar-dot" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
