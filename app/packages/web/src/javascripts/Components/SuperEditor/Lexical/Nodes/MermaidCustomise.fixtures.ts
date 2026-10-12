/**
 * One small, valid diagram of every kind `detectMermaidDiagramType` can name,
 * keyed by that name — plus `unknown`, a kind mermaid draws and this app has no
 * name for.
 *
 * Shared by the Customise specs and by scripts/MermaidConfigContract.mjs, which
 * holds each one to the real library: mermaid must accept it as written and
 * after every control and every preset has been applied to it. Test data only;
 * nothing in the app imports this file.
 */
export const MERMAID_SAMPLE_DIAGRAMS: Record<string, string> = {
  flowchart: 'flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[OK]\n  B -->|No| D[Rethink]',
  sequence:
    'sequenceDiagram\n  participant U as User\n  participant S as Server\n  U->>S: Request\n  S-->>U: Response\n  Note over U,S: hello',
  class: 'classDiagram\n  class Animal {\n    +String name\n    +eat() void\n  }\n  Animal <|-- Dog\n  Animal <|-- Cat',
  state: 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running : start\n  Running --> Idle : stop\n  Running --> [*]',
  er: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE : contains\n  CUSTOMER {\n    string name PK\n  }',
  gantt:
    'gantt\n  dateFormat YYYY-MM-DD\n  title Plan\n  section One\n  Research :t0, 2024-01-01, 5d\n  Build :t1, after t0, 7d',
  pie: 'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85\n  "Rats" : 15',
  journey: 'journey\n  title My day\n  section Work\n    Make tea: 5: Me\n    Do work: 1: Me, Cat',
  gitGraph: 'gitGraph\n  commit id: "a"\n  branch dev\n  commit id: "b"\n  checkout main\n  merge dev',
  mindmap: 'mindmap\n  root((Root))\n    Alpha\n      A1\n      A2\n    Beta\n      B1',
  timeline: 'timeline\n  title History\n  2002 : LinkedIn\n  2004 : Facebook : Google\n  2005 : YouTube',
  quadrant:
    'quadrantChart\n  title Reach\n  x-axis Low --> High\n  y-axis Low --> High\n  quadrant-1 Expand\n  quadrant-2 Promote\n  quadrant-3 Re-evaluate\n  quadrant-4 Improve\n  A: [0.3, 0.6]',
  requirement:
    'requirementDiagram\n  requirement r1 {\n    id: 1\n    text: the test\n    risk: high\n    verifymethod: test\n  }\n  element e1 {\n    type: simulation\n  }\n  e1 - satisfies -> r1',
  sankey: 'sankey-beta\n  A,B,10\n  A,C,5\n  B,D,8',
  xychart: 'xychart-beta\n  title "Sales"\n  x-axis [jan, feb, mar]\n  y-axis "Revenue" 0 --> 100\n  bar [50, 60, 75]',
  block: 'block-beta\n  columns 2\n  a b\n  c d',
  c4: 'C4Context\n  title Sys\n  Person(a, "User")\n  System(b, "Bank")\n  Rel(a, b, "Uses")',
  unknown: 'kanban\n  Todo\n    [Write docs]\n  Done\n    [Ship]',
}
