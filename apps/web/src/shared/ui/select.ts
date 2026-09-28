export type SelectValue = string | number | null;
export interface SelectOption {
  value: SelectValue;
  label: string;
  disabled?: boolean;
}
