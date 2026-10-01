/** "Location: Before/After page N" fields shared by the insert dialogs. */
import { NumberField, Select } from '@/core/ui';

export type Where = 'first' | 'last' | 'before' | 'after';

export interface Position {
  where: Where;
  /** 1-based page number for before / after. */
  page: number;
}

/** Initial position for an insertion index 0..count. */
export function positionFor(at: number, count: number): Position {
  if (at <= 0) return { where: 'first', page: 1 };
  if (at >= count) return { where: 'last', page: count };
  return { where: 'after', page: at };
}

/** Insertion index for a position. */
export function indexOf(p: Position, count: number): number {
  const page = Math.max(1, Math.min(count, Math.round(p.page) || 1));
  switch (p.where) {
    case 'first': return 0;
    case 'last': return count;
    case 'before': return page - 1;
    default: return page;
  }
}

export function PositionFields({ value, onChange, count, testid }: { value: Position; onChange(p: Position): void; count: number; testid: string }) {
  const needsPage = value.where === 'before' || value.where === 'after';
  return (
    <div className="organize-dialog-row">
      <Select
        label="Location"
        value={value.where}
        onChange={(where) => onChange({ ...value, where })}
        options={[
          { value: 'first', label: 'Before the first page' },
          { value: 'last', label: 'After the last page' },
          { value: 'before', label: 'Before page' },
          { value: 'after', label: 'After page' },
        ]}
        data-testid={`${testid}-where`}
      />
      <div className="organize-dialog-page" data-testid={`${testid}-page`}>
        <NumberField
          label="Page"
          value={value.page}
          onChange={(page) => onChange({ ...value, page })}
          min={1}
          max={count}
          width={124}
          disabled={!needsPage}
          suffix={`of ${count}`}
          aria-label="Page number"
        />
      </div>
    </div>
  );
}
