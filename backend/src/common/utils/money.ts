// Money: all money is stored as integer paisa in the DB (bigint) and as
// PKR decimal (numeric(12,2)) on some legacy columns. 1 PKR = 100 paisa.
export function pkrToPaisa(pkr: number): number {
  return Math.round(pkr * 100);
}
export function paisaToPkr(paisa: number): number {
  return paisa / 100;
}
export function formatPkr(pkr: number): string {
  return `PKR ${pkr.toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
/** Commission (default 10%) on an agreed price, in paisa. Rounds half-up. */
export function commissionPaisa(finalPricePaisa: number, rate = 0.1): number {
  return Math.round(finalPricePaisa * rate);
}
export function isValidPkrAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && Math.round(v * 100) === v * 100;
}
