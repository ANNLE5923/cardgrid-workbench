import type { DataV5 } from './contracts-v06.ts';
import type { Range } from './contracts.ts';
import { V06ContractError } from './v06-validation.ts';
import { dateAt, dayRange, intersectRanges } from '../daily/time.ts';

type ArchiveScope = Pick<DataV5, 'archiveIndex'>;
function denied(): never {
  throw new V06ContractError(
    'ARCHIVE_READ_ONLY',
    'date',
    '已归档日期只读，请在当前活动日记录新的安排或感想',
  );
}
export function assertV06WritableDate(data: ArchiveScope, date: string): void {
  if (data.archiveIndex.some((index) => index.coveredDates.includes(date))) denied();
}
/** Test actual instants in each archive's frozen zone, including cross-midnight ranges. */
export function assertV06WritableRange(data: ArchiveScope, range: Range): void {
  for (const index of data.archiveIndex)
    for (const date of index.coveredDates) {
      if (intersectRanges(range, dayRange(date, index.zone))) denied();
    }
}
export function assertV06WritablePoint(data: ArchiveScope, at: string): void {
  if (data.archiveIndex.some((index) => index.coveredDates.includes(dateAt(at, index.zone))))
    denied();
}
