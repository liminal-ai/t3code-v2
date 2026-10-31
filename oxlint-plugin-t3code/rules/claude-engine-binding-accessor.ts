import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const ADAPTER_FILE_PATTERN = /(?:^|[\\/])ClaudeAdapterV2\.ts$/u;
const ACCESSOR_MODULE_PATTERN = /(?:^|\/)claudeLhc\/(?:binding|traits)(?:\.ts)?$/u;
const WRAPPER_TYPES = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSNonNullExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

const message =
  "Read a provider row's engineBinding through rowEngineBinding, copyEngineBinding or checkClaudeEngineBinding in claudeLhc/binding.ts, or claudeThreadTraits in claudeLhc/traits.ts. Pass the thread's seed or the instance's template straight into one of them.";

const memberPropertyName = (node: ESTree.MemberExpression): Option.Option<string> => {
  if (!node.computed) return getPropertyName(node.property);
  const property = unwrapExpression(node.property);
  if (Option.isSome(property) && property.value.type === "TemplateLiteral") {
    return property.value.expressions.length === 0
      ? Option.fromNullishOr(property.value.quasis[0]?.value.cooked)
      : Option.none();
  }
  return Option.flatMap(property, (expression) =>
    expression.type === "Literal" ? getPropertyName(expression) : Option.none(),
  );
};

const readsRowMetadata = (node: ESTree.MemberExpression) => {
  const object = unwrapExpression(node.object);
  return (
    Option.isSome(object) &&
    object.value.type === "MemberExpression" &&
    Option.getOrUndefined(memberPropertyName(object.value)) === "nativeMetadata"
  );
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep the Claude adapter's engine binding reads inside the claudeLhc binding and traits accessors.",
    },
  },
  create(context) {
    if (!ADAPTER_FILE_PATTERN.test(context.filename)) return {};
    const accessors = new Set<string>();
    const accessorNamespaces = new Set<string>();
    const reads: Array<ESTree.Node> = [];

    const callsAccessor = (callee: ESTree.Node) => {
      const target = unwrapExpression(callee);
      if (Option.isNone(target)) return false;
      if (target.value.type === "Identifier") return accessors.has(target.value.name);
      return (
        target.value.type === "MemberExpression" &&
        !target.value.computed &&
        target.value.object.type === "Identifier" &&
        accessorNamespaces.has(target.value.object.name)
      );
    };

    const isAccessorArgument = (node: ESTree.Node) => {
      let child: ESTree.Node = node;
      let parent = node.parent;
      while (parent != null && WRAPPER_TYPES.has(parent.type)) {
        child = parent;
        parent = parent.parent;
      }
      return (
        parent?.type === "CallExpression" &&
        parent.arguments.some((argument) => argument === child) &&
        callsAccessor(parent.callee)
      );
    };

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        if (typeof node.source.value !== "string") return;
        if (!ACCESSOR_MODULE_PATTERN.test(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            accessorNamespaces.add(specifier.local.name);
          } else if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type") {
            accessors.add(specifier.local.name);
          }
        }
      },
      MemberExpression(node) {
        if (Option.getOrUndefined(memberPropertyName(node)) !== "engineBinding") return;
        if (readsRowMetadata(node)) context.report({ node, message });
        else reads.push(node);
      },
      ObjectPattern(node) {
        for (const property of node.properties) {
          if (
            property.type === "Property" &&
            Option.getOrUndefined(getPropertyName(property.key)) === "engineBinding"
          ) {
            reads.push(property);
          }
        }
      },
      "Program:exit"() {
        for (const node of reads) {
          if (!isAccessorArgument(node)) context.report({ node, message });
        }
      },
    };
  },
});
