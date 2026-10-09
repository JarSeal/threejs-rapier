::: scene exampleDebugTab
A ring of boxes. In debug mode, press `h` and open the drawer's Boxes tab: it sets the number of
boxes and their colour, and shuffles them.
:::

The debug drawer is where the engine's own tools are, and your scenes can add tabs to it. A tab
is one [`createDebuggerTab`](api:createDebuggerTab) call: a list of controls bound to an object,
with what to save and when to refresh.
