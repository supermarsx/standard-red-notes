import { SelectorInterface } from './SelectorInterface';
export declare class DeterministicSelector<T> implements SelectorInterface<T> {
    private readonly CHAR_0_CODE;
    select(inputKey: string, values: T[]): T;
}
