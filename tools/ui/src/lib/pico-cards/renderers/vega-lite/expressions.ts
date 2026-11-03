import type { VegaSpec } from './policy';

interface ExpressionNode {
	type: string;
	name?: string;
	value?: unknown;
	regex?: unknown;
	computed?: boolean;
	operator?: string;
	property?: ExpressionNode;
	object?: ExpressionNode;
	argument?: ExpressionNode;
	left?: ExpressionNode;
	right?: ExpressionNode;
	test?: ExpressionNode;
	consequent?: ExpressionNode;
	alternate?: ExpressionNode;
	callee?: ExpressionNode;
	arguments?: ExpressionNode[];
}

const forbiddenProperties = new Set(['__proto__', 'constructor', 'prototype']);
const constants = new Set([
	'datum',
	'PI',
	'E',
	'LN2',
	'LN10',
	'LOG2E',
	'LOG10E',
	'SQRT1_2',
	'SQRT2',
	'undefined',
	'NaN'
]);
const functions = new Set([
	'if',
	'isValid',
	'isFinite',
	'isNaN',
	'isNumber',
	'isString',
	'isBoolean',
	'isDate',
	'isArray',
	'toNumber',
	'toString',
	'toBoolean',
	'toDate',
	'abs',
	'acos',
	'asin',
	'atan',
	'atan2',
	'ceil',
	'clamp',
	'cos',
	'exp',
	'floor',
	'hypot',
	'log',
	'max',
	'min',
	'pow',
	'round',
	'sin',
	'sqrt',
	'tan',
	'datetime',
	'utc',
	'year',
	'quarter',
	'month',
	'date',
	'day',
	'hours',
	'minutes',
	'seconds',
	'milliseconds',
	'time',
	'utcyear',
	'utcquarter',
	'utcmonth',
	'utcdate',
	'utcday',
	'utchours',
	'utcminutes',
	'utcseconds',
	'utcmilliseconds',
	'length',
	'lower',
	'upper',
	'trim',
	'substring',
	'slice',
	'indexof',
	'lastindexof'
]);
const unary = new Set(['+', '-', '!']);
const binary = new Set([
	'+',
	'-',
	'*',
	'/',
	'%',
	'**',
	'==',
	'!=',
	'===',
	'!==',
	'<',
	'<=',
	'>',
	'>='
]);

/** Validate author expressions with Vega's parser; the official interpreter evaluates them. */
export function acceptsVegaExpression(source: string, parse: (source: string) => unknown): boolean {
	if (!source || source.length > 8_192) return false;

	let nodes = 0;

	function property(node: ExpressionNode): boolean {
		const prop = node.property;

		if (!prop) return false;

		if (node.computed) {
			if (prop.type !== 'Literal') return false;

			return typeof prop.value === 'string'
				? prop.value.length <= 256 && !forbiddenProperties.has(prop.value)
				: typeof prop.value === 'number' &&
						Number.isInteger(prop.value) &&
						prop.value >= 0 &&
						prop.value < 4_096;
		}

		return prop.type === 'Identifier' && !!prop.name && !forbiddenProperties.has(prop.name);
	}

	function member(node: ExpressionNode | undefined, depth: number): boolean {
		if (!node || ++nodes > 256 || depth > 24) return false;

		if (node.type === 'Identifier') return node.name === 'datum';

		return node.type === 'MemberExpression' && property(node) && member(node.object, depth + 1);
	}

	function visit(node: ExpressionNode | undefined, depth: number): boolean {
		if (!node || ++nodes > 256 || depth > 24) return false;

		switch (node.type) {
			case 'Literal':
				return (
					!node.regex &&
					(node.value === null ||
						typeof node.value === 'boolean' ||
						(typeof node.value === 'number' &&
							Number.isFinite(node.value) &&
							Math.abs(node.value) <= 1e12) ||
						(typeof node.value === 'string' && node.value.length <= 8_192))
				);
			case 'Identifier':
				return !!node.name && constants.has(node.name);
			case 'MemberExpression':
				return property(node) && member(node.object, depth + 1);
			case 'UnaryExpression':
				return !!node.operator && unary.has(node.operator) && visit(node.argument, depth + 1);
			case 'BinaryExpression':
				return (
					!!node.operator &&
					binary.has(node.operator) &&
					visit(node.left, depth + 1) &&
					visit(node.right, depth + 1)
				);
			case 'LogicalExpression':
				return (
					(node.operator === '&&' || node.operator === '||') &&
					visit(node.left, depth + 1) &&
					visit(node.right, depth + 1)
				);
			case 'ConditionalExpression':
				return (
					visit(node.test, depth + 1) &&
					visit(node.consequent, depth + 1) &&
					visit(node.alternate, depth + 1)
				);
			case 'CallExpression':
				return (
					node.callee?.type === 'Identifier' &&
					!!node.callee.name &&
					functions.has(node.callee.name) &&
					Array.isArray(node.arguments) &&
					node.arguments.length <= 16 &&
					node.arguments.every((arg) => visit(arg, depth + 1))
				);
			default:
				return false;
		}
	}
	try {
		return visit(parse(source) as ExpressionNode, 0);
	} catch {
		return false;
	}
}

export function prepareVegaExpressions(spec: VegaSpec, parse: (source: string) => unknown): void {
	function predicate(value: unknown): unknown {
		if (typeof value === 'string') {
			if (!acceptsVegaExpression(value, parse)) throw new Error('Unsupported chart expression');

			return `picoBoundedExpression((${value}))`;
		}

		if (value && typeof value === 'object' && !Array.isArray(value)) {
			const record = value as VegaSpec;

			for (const key of ['and', 'or']) {
				if (Array.isArray(record[key])) record[key] = record[key].map(predicate);
			}

			if (record.not !== undefined) record.not = predicate(record.not);
		}

		return value;
	}

	function visit(value: unknown): void {
		if (!value || typeof value !== 'object') return;

		if (Array.isArray(value)) {
			value.forEach(visit);

			return;
		}

		const record = value as VegaSpec;

		for (const [key, child] of Object.entries(record)) {
			if (key === 'values' || key === 'datasets') continue;

			if (key === 'calculate') record[key] = predicate(child);
			else if (key === 'filter' || key === 'test') record[key] = predicate(child);
			else visit(child);
		}
	}
	visit(spec);
}
