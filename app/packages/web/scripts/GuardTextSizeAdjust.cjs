// Preserve mobile text sizing and conditionally apply supported declarations.
// Browsers still parse @supports contents and may report unsupported declarations.
// Runs after Tailwind/preflight and autoprefixer, including their
// generated vendor declarations; dependencies remain untouched.
module.exports = () => ({
  postcssPlugin: 'guard-text-size-adjust',
  OnceExit(root, { postcss }) {
    const insertionPoints = new WeakMap()
    root.walkDecls(/^(?:-webkit-)?text-size-adjust$/, (declaration) => {
      const condition = `(${declaration.prop}: ${declaration.value})`
      let ancestor = declaration.parent
      while (ancestor) {
        if (ancestor.type === 'atrule' && ancestor.name === 'supports' && ancestor.params === condition) {
          return
        }
        ancestor = ancestor.parent
      }
      const rule = declaration.parent
      if (rule.type !== 'rule') {
        return
      }
      const guardedRule = rule.clone({ nodes: [] })
      guardedRule.append(declaration.clone())
      const supports = postcss.atRule({ name: 'supports', params: condition })
      supports.append(guardedRule)
      const insertionPoint = insertionPoints.get(rule) ?? rule
      insertionPoint.after(supports)
      insertionPoints.set(rule, supports)
      declaration.remove()
      if (rule.nodes.length === 0) {
        rule.remove()
      }
    })
  },
})
module.exports.postcss = true
