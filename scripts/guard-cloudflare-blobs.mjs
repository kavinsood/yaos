#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePaths = {
	route: "server/src/routes/blobs.ts",
	helper: "server/src/cloudflareVerifiedObjectStream.ts",
	ports: "server/src/cloudflarePorts.ts",
};

function unwrap(node) {
	while (node && (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node))) {
		node = node.expression;
	}
	return node;
}

function identifier(node, name) {
	return node && ts.isIdentifier(node) && node.text === name;
}

function memberName(node) {
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
		return node.argumentExpression.text;
	}
	return null;
}

function property(node, owner, name) {
	return node && ts.isPropertyAccessExpression(node) && !node.questionDotToken
		&& identifier(node.expression, owner) && identifier(node.name, name);
}

function collect(node, predicate) {
	const matches = [];
	function visit(current) {
		if (predicate(current)) matches.push(current);
		ts.forEachChild(current, visit);
	}
	visit(node);
	return matches;
}

function objectProperties(node) {
	if (!node || !ts.isObjectLiteralExpression(node)) return null;
	const properties = new Map();
	for (const entry of node.properties) {
		if ((!ts.isPropertyAssignment(entry) && !ts.isShorthandPropertyAssignment(entry))
			|| (!ts.isIdentifier(entry.name) && !ts.isStringLiteral(entry.name))
			|| properties.has(entry.name.text) || entry.objectAssignmentInitializer) return null;
		properties.set(entry.name.text, ts.isShorthandPropertyAssignment(entry) ? entry.name : entry.initializer);
	}
	return properties;
}

function expectedExpression(text) {
	const source = ts.createSourceFile("expected.ts", `const expected = ${text};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	return source.statements[0].declarationList.declarations[0].initializer;
}

function sameExpression(actual, expected) {
	if (!actual || actual.kind !== expected.kind || Boolean(actual.questionDotToken) !== Boolean(expected.questionDotToken)) return false;
	const actualChildren = [];
	const expectedChildren = [];
	ts.forEachChild(actual, (child) => { actualChildren.push(child); });
	ts.forEachChild(expected, (child) => { expectedChildren.push(child); });
	if (actualChildren.length !== expectedChildren.length) return false;
	if (!actualChildren.length) {
		return ts.isStringLiteral(actual) ? actual.text === expected.text : actual.getText() === expected.getText();
	}
	return actualChildren.every((child, index) => sameExpression(child, expectedChildren[index]));
}

const routeReplacement = expectedExpression("existing && (existing.sha256 !== hash || suspect) ? existing.etag : undefined");
const routeSuspect = expectedExpression("existing ? (await blobSuspects(env, vaultId, vaultGeneration, actor, [key])).includes(key) : false");
const validObject = expectedExpression('existing?.checksums?.sha256 && Array.from(new Uint8Array(existing.checksums.sha256), (byte) => byte.toString(16).padStart(2, "0")).join("") === options.sha256');
const existingObjectGate = expectedExpression("existing && (options.replaceEtag !== existing.etag || (valid && !options.replaceEtag))");
const replacementCondition = expectedExpression("existing");

function imported(source, symbol, module) {
	return source.statements.some((statement) => ts.isImportDeclaration(statement)
		&& ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === module
		&& !statement.importClause?.isTypeOnly
		&& statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
		&& statement.importClause.namedBindings.elements.some((entry) => !entry.isTypeOnly
			&& identifier(entry.name, symbol) && (!entry.propertyName || identifier(entry.propertyName, symbol))));
}

function negated(node, predicate) {
	node = unwrap(node);
	return node && ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken
		&& predicate(unwrap(node.operand));
}

function throwsImmediately(statement) {
	if (!statement || !ts.isIfStatement(statement) || statement.elseStatement) return false;
	const rejection = ts.isBlock(statement.thenStatement)
		? statement.thenStatement.statements : [statement.thenStatement];
	return rejection.length === 1 && ts.isThrowStatement(rejection[0]);
}

function lengthGuard(statement) {
	if (!throwsImmediately(statement)) return false;
	const condition = unwrap(statement.expression);
	return ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.BarBarToken
		&& negated(condition.left, (expression) => ts.isCallExpression(expression)
			&& property(expression.expression, "Number", "isSafeInteger") && expression.arguments.length === 1
			&& property(expression.arguments[0], "options", "length"))
		&& ts.isBinaryExpression(condition.right) && condition.right.operatorToken.kind === ts.SyntaxKind.LessThanToken
		&& property(condition.right.left, "options", "length")
		&& ts.isNumericLiteral(condition.right.right) && condition.right.right.text === "1";
}

function keyBindingGuard(statement) {
	if (!throwsImmediately(statement)) return false;
	const condition = unwrap(statement.expression);
	if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.BarBarToken) return false;
	const validHash = negated(condition.left, (expression) => ts.isCallExpression(expression)
		&& !expression.questionDotToken && expression.arguments.length === 1
		&& property(expression.arguments[0], "options", "sha256")
		&& ts.isPropertyAccessExpression(expression.expression) && !expression.expression.questionDotToken
		&& identifier(expression.expression.name, "test")
		&& ts.isRegularExpressionLiteral(expression.expression.expression)
		&& ["/^[a-f0-9]{64}$/", "/^[0-9a-f]{64}$/"].includes(expression.expression.expression.text));
	const validKey = negated(condition.right, (expression) => {
		if (!ts.isCallExpression(expression) || expression.questionDotToken
			|| !property(expression.expression, "key", "endsWith") || expression.arguments.length !== 1) return false;
		const suffix = expression.arguments[0];
		return ts.isTemplateExpression(suffix) && suffix.head.text === "/blobs/"
			&& suffix.templateSpans.length === 1 && suffix.templateSpans[0].literal.text === ""
			&& property(suffix.templateSpans[0].expression, "options", "sha256");
	});
	return validHash && validKey;
}

export function checkCloudflareBlobs(sources) {
	const failures = [];
	const parsed = {};
	const fail = (name, message) => failures.push(`${sourcePaths[name]}: ${message}`);
	for (const [name, path] of Object.entries(sourcePaths)) {
		parsed[name] = ts.createSourceFile(path, sources[name], ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		if (parsed[name].parseDiagnostics.length) fail(name, "source must parse without syntax errors");
	}
	const { route, helper, ports } = parsed;
	if (!imported(route, "blobKey", "../vaultObjectStore")) fail("route", "must import the canonical blobKey");
	if (collect(route, (node) => ["put", "createOnly"].includes(memberName(node))).length) {
		fail("route", "blob writes must not bypass verification via put/createOnly");
	}
	const uploads = collect(route, (node) => ts.isCallExpression(node)
		&& memberName(node.expression) === "createOnlyVerifiedStream");
	if (uploads.length !== 1) {
		fail("route", "must contain exactly one createOnlyVerifiedStream upload");
	} else {
		const upload = uploads[0];
		const [key, body, options] = upload.arguments;
		const fields = objectProperties(options);
		const uploadHandler = route.statements.find((statement) => ts.isFunctionDeclaration(statement)
			&& identifier(statement.name, "handleBlobUpload"));
		const suspectDeclarations = uploadHandler?.body ? collect(uploadHandler.body, (node) => ts.isVariableDeclaration(node)
			&& identifier(node.name, "suspect")) : [];
		if (suspectDeclarations.length !== 1 || !sameExpression(suspectDeclarations[0].initializer, routeSuspect)
			|| suspectDeclarations[0].pos >= upload.pos) {
			fail("route", "suspect must be derived from blobSuspects for the existing key before upload");
		}
		if (upload.questionDotToken || !property(upload.expression, "bucket", "createOnlyVerifiedStream")
			|| upload.arguments.length !== 3 || !(identifier(key, "key") || (key && ts.isCallExpression(key) && !key.questionDotToken
				&& identifier(key.expression, "blobKey") && key.arguments.length === 3
				&& key.arguments.every((argument, index) => identifier(argument, ["vaultId", "vaultGeneration", "hash"][index]))))
			|| !identifier(body, "body") || !fields || !identifier(fields.get("sha256"), "hash")
			|| !identifier(fields.get("length"), "length")
			|| !sameExpression(fields.get("replaceEtag"), routeReplacement)) {
			fail("route", "upload must bind blobKey(vaultId, vaultGeneration, hash), body, sha256: hash, length and conditional replaceEtag without option overrides");
		}
	}
	const helpers = helper.statements.filter((node) => ts.isFunctionDeclaration(node)
		&& identifier(node.name, "createCloudflareVerifiedObjectStream"));
	const helperBody = helpers.length === 1 ? helpers[0].body : null;
	const bindingIndex = helperBody && lengthGuard(helperBody.statements[0]) ? 1 : 0;
	if (!helperBody || !keyBindingGuard(helperBody.statements[bindingIndex])) {
		fail("helper", "must reject invalid SHA-256 or a key not ending in /blobs/${options.sha256} before any work");
	}
	const validDeclarations = helperBody ? collect(helperBody, (node) => ts.isVariableDeclaration(node)
		&& identifier(node.name, "valid")) : [];
	if (validDeclarations.length !== 1 || !helperBody.statements.some((statement) => ts.isVariableStatement(statement)
		&& statement.declarationList.declarations.length === 1 && statement.declarationList.declarations[0] === validDeclarations[0])
		|| !sameExpression(validDeclarations[0].initializer, validObject)) {
		fail("helper", "valid must compare the existing object's SHA-256 checksum with options.sha256");
	}
	if (collect(helper, (node) => ["DigestStream", "verifyObjectStream", "subtle"]
		.includes(ts.isIdentifier(node) ? node.text : memberName(node))).length) {
		fail("helper", "Worker hashing via DigestStream, subtle.digest or verifyObjectStream is forbidden; R2 must verify the checksum");
	}
	const writes = collect(helper, (node) => ts.isCallExpression(node)
		&& ["put", "createOnly", "createOnlyVerifiedStream"].includes(memberName(node.expression)));
	const writeReferences = collect(helper, (node) => ["put", "createOnly", "createOnlyVerifiedStream"].includes(memberName(node)));
	if (writes.length !== 1 || writeReferences.length !== 1
		|| !helperBody || !collect(helperBody, (node) => node === writes[0]).length) {
		fail("helper", "must contain exactly one conditional bucket.put publication");
	} else {
		const write = writes[0];
		const [key, body, options] = write.arguments;
		const fields = objectProperties(options);
		const condition = unwrap(fields?.get("onlyIf"));
		const createCondition = condition && ts.isConditionalExpression(condition) ? objectProperties(condition.whenFalse) : objectProperties(condition);
		const replaceCondition = condition && ts.isConditionalExpression(condition) ? objectProperties(condition.whenTrue) : null;
		const etag = createCondition?.get("etagDoesNotMatch");
		let publication = write.parent;
		while (publication && !(ts.isArrowFunction(publication) && ts.isBlock(publication.body))) publication = publication.parent;
		const gate = publication?.body.statements[0];
		const rejection = gate && ts.isIfStatement(gate) && ts.isBlock(gate.thenStatement)
			? gate.thenStatement.statements : [];
		if (!gate || !ts.isIfStatement(gate) || gate.elseStatement
			|| !sameExpression(gate.expression, existingObjectGate)
			|| rejection.length !== 2 || !ts.isExpressionStatement(rejection[0])
			|| !ts.isAwaitExpression(rejection[0].expression)
			|| !ts.isCallExpression(rejection[0].expression.expression)
			|| !identifier(rejection[0].expression.expression.expression, "drain")
			|| rejection[0].expression.expression.arguments.length !== 0
			|| !ts.isReturnStatement(rejection[1])
			|| !ts.isStringLiteral(unwrap(rejection[1].expression))
			|| unwrap(rejection[1].expression).text !== "exists") {
			fail("helper", "must drain and return before publication when an existing object is not eligible for replacement");
		}
		if (write.questionDotToken || !property(write.expression, "bucket", "put")
			|| write.arguments.length !== 3 || !identifier(key, "key") || !property(body, "output", "readable")
			|| !fields || !property(fields.get("sha256"), "options", "sha256")
			|| !createCondition || createCondition.size !== 1 || !etag || !ts.isStringLiteral(etag) || etag.text !== "*"
			|| !condition || !ts.isConditionalExpression(condition)
			|| !sameExpression(condition.condition, replacementCondition)
			|| !replaceCondition || replaceCondition.size !== 1
			|| !property(replaceCondition.get("etagMatches"), "existing", "etag")) {
			fail("helper", "bucket.put must use key, output.readable, sha256: options.sha256 and conditional create/replacement without overrides");
		}
	}
	if (!imported(ports, "createCloudflareVerifiedObjectStream", "./cloudflareVerifiedObjectStream")) {
		fail("ports", "must import the verified Cloudflare helper");
	}
	const stores = ports.statements.filter((node) => ts.isClassDeclaration(node)
		&& identifier(node.name, "CloudflareObjectStore"));
	const methods = stores.flatMap((store) => store.members.filter((node) => ts.isMethodDeclaration(node)
		&& identifier(node.name, "createOnlyVerifiedStream")));
	const statements = methods.length === 1 ? methods[0].body?.statements : null;
	const delegation = statements?.length === 1 && ts.isReturnStatement(statements[0])
		? unwrap(statements[0].expression) : null;
	if (!delegation || !ts.isCallExpression(delegation) || delegation.questionDotToken
		|| !identifier(delegation.expression, "createCloudflareVerifiedObjectStream") || delegation.arguments.length !== 4
		|| !ts.isPropertyAccessExpression(delegation.arguments[0])
		|| delegation.arguments[0].expression.kind !== ts.SyntaxKind.ThisKeyword
		|| !identifier(delegation.arguments[0].name, "bucket")
		|| !delegation.arguments.slice(1).every((argument, index) => identifier(argument, ["key", "body", "options"][index]))) {
		fail("ports", "createOnlyVerifiedStream must delegate this.bucket, key, body and options to the verified helper");
	}
	return failures;
}

export function guardCloudflareBlobs(root = rootDir) {
	const sources = Object.fromEntries(Object.entries(sourcePaths)
		.map(([name, path]) => [name, readFileSync(resolve(root, path), "utf8")]));
	const failures = checkCloudflareBlobs(sources);
	if (failures.length) throw new Error(`Cloudflare blob integrity guard failed:\n${failures.join("\n")}`);
	console.log("Cloudflare blob integrity guard passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		guardCloudflareBlobs();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
