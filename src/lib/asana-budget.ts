import { DEFAULT_REQUESTS_PER_MINUTE as DEFAULT_RATE, PAID_REQUESTS_PER_MINUTE as PAID_RATE } from "./asana-pace";

const FULL_READ_CALLS_PER_TASK = 2;

export const fullReadMinutes = (tasks: number, paid: boolean): number => Math.ceil((tasks * FULL_READ_CALLS_PER_TASK) / (paid ? PAID_RATE : DEFAULT_RATE));
