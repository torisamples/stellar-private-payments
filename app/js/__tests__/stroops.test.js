/**
 * Tests for xlmToStroops and stroopsToXlmDisplay utilities.
 * These functions replace floating-point arithmetic with integer-based
 * stroops math to prevent rounding errors in financial calculations.
 */

// We can't import from core.js directly due to its dependency on bridge.js / WASM,
// so we duplicate the functions here for isolated unit testing.
// The canonical implementations live in ui/core.js.

function xlmToStroops(xlm) {
    const str = String(xlm).trim();
    if (!str || str === 'NaN') return 0n;

    const negative = str.startsWith('-');
    const abs = negative ? str.slice(1) : str;

    const [whole = '0', frac = ''] = abs.split('.');
    const fracPadded = (frac + '0000000').slice(0, 7);
    const stroops = BigInt(whole) * 10_000_000n + BigInt(fracPadded);

    return negative ? -stroops : stroops;
}

function stroopsToXlmDisplay(stroops) {
    const n = Number(stroops);
    const xlm = n / 1e7;
    return xlm.toFixed(7).replace(/\.?0+$/, '');
}

describe('xlmToStroops', () => {
    test('converts whole XLM amounts', () => {
        expect(xlmToStroops('10')).toBe(100_000_000n);
        expect(xlmToStroops('0')).toBe(0n);
        expect(xlmToStroops('1')).toBe(10_000_000n);
        expect(xlmToStroops('1000')).toBe(10_000_000_000n);
    });

    test('converts fractional XLM amounts', () => {
        expect(xlmToStroops('0.1')).toBe(1_000_000n);
        expect(xlmToStroops('0.0000001')).toBe(1n);
        expect(xlmToStroops('1.5')).toBe(15_000_000n);
        expect(xlmToStroops('99.9999999')).toBe(999_999_999n);
    });

    test('avoids classic floating-point errors', () => {
        // 0.1 + 0.2 in floating point = 0.30000000000000004
        // With stroops: 1000000 + 2000000 = 3000000 (exact)
        const a = xlmToStroops('0.1');
        const b = xlmToStroops('0.2');
        const expected = xlmToStroops('0.3');
        expect(a + b).toBe(expected);
    });

    test('handles the deposit balance scenario that triggered the bug', () => {
        // User deposits 10 XLM, splits into 7.1234567 and 2.8765433
        const deposit = xlmToStroops('10');
        const out1 = xlmToStroops('7.1234567');
        const out2 = xlmToStroops('2.8765433');
        expect(out1 + out2).toBe(deposit);
    });

    test('handles negative amounts (for transact public amount)', () => {
        expect(xlmToStroops('-5')).toBe(-50_000_000n);
        expect(xlmToStroops('-0.5')).toBe(-5_000_000n);
    });

    test('handles edge cases', () => {
        expect(xlmToStroops('')).toBe(0n);
        expect(xlmToStroops('NaN')).toBe(0n);
        expect(xlmToStroops('  42  ')).toBe(420_000_000n);
    });

    test('truncates beyond 7 decimal places', () => {
        // 0.00000001 is below stroops precision, should truncate to 0
        expect(xlmToStroops('0.00000001')).toBe(0n);
        // 1.23456789 should truncate to 1.2345678
        expect(xlmToStroops('1.23456789')).toBe(12_345_678n);
    });
});

describe('stroopsToXlmDisplay', () => {
    test('formats whole amounts', () => {
        expect(stroopsToXlmDisplay(100_000_000n)).toBe('10');
        expect(stroopsToXlmDisplay(0n)).toBe('0');
    });

    test('formats fractional amounts and trims trailing zeros', () => {
        expect(stroopsToXlmDisplay(15_000_000n)).toBe('1.5');
        expect(stroopsToXlmDisplay(1n)).toBe('0.0000001');
        expect(stroopsToXlmDisplay(1_000_000n)).toBe('0.1');
    });

    test('formats negative amounts', () => {
        expect(stroopsToXlmDisplay(-50_000_000n)).toBe('-5');
    });
});

describe('balance equation correctness', () => {
    test('deposit: deposit === outputs (exact integer comparison)', () => {
        const deposit = xlmToStroops('100');
        const out1 = xlmToStroops('70');
        const out2 = xlmToStroops('30');
        expect(deposit === out1 + out2).toBe(true);
    });

    test('transfer: inputs === outputs (exact integer comparison)', () => {
        const input1 = 50_000_000n; // note amount in stroops
        const input2 = 30_000_000n;
        const out1 = xlmToStroops('5');
        const out2 = xlmToStroops('3');
        expect(input1 + input2 === out1 + out2).toBe(true);
    });

    test('transact: inputs + public === outputs (exact integer comparison)', () => {
        const inputs = 100_000_000n;
        const publicAmount = xlmToStroops('-3');
        const out1 = xlmToStroops('5');
        const out2 = xlmToStroops('2');
        expect(inputs + publicAmount === out1 + out2).toBe(true);
    });
});
