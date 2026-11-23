# Task graph

A build plan holds one or more tasks. Each task names the tasks that must
finish before it starts, and the engine runs the tasks one at a time in that
order. For how tasks fit into a build, see the
[build pipeline design](design.md).

## Dependencies

The `dependsOn` field of a task lists the IDs of the tasks it depends on. It
defaults to an empty list. The engine refuses a build request, before it
creates the build branch, when the plan has either of the following problems:

- A task depends on a task that the plan doesn't have.
- The tasks form a dependency cycle. The message names the cycle, such as
  `T1 -> T3 -> T2 -> T1`, where each task depends on the next one.

The `taskOrder()` and `dependencyCycle()` functions in the
`packages/contracts/src/task-graph.ts` file compute the order and find a
cycle. The order puts each task after every task it depends on, and otherwise
keeps the plan order.

## Task gate

The gate of a task treats the other tasks of the plan in two groups:

- **Earlier tasks:** the tasks that finished. Their tests must still pass.
- **Later tasks:** the tasks that haven't finished. Tests first wrote their
  tests red, so the gate doesn't run them.

For a plan with several tasks, the gate works as follows:

1. It skips a test command that names only test files of later tasks, and
   lists the command in the `deferred` field of the gate result.
1. While the test commands run, it sets the test files of later tasks aside
   and then puts them back, so that a command that runs the whole suite skips
   them. The gate result lists those files in the `setAside` field. A glob,
   and a file that the gated task or an earlier task also lists, stay in
   place.
1. It runs the test lock's command for each test of an earlier task, unless a
   plan test command is the same command.
1. It reports a regression for each earlier task's test that fails: a failing
   command that names the test file, has a failure line that names it, or
   that the test lock lists for it. The `regressions` field of the gate result
   lists each one, and a regression fails the gate.

The next attempt's prompt names each broken test and the task that made it
pass.

## Oscillation

When an attempt breaks an earlier task's test, and an earlier attempt at the
same task broke the same test, the task oscillates between the two tasks'
behavior. The engine fails the task and raises an `oscillation` escalation
for the Project manager, with the gate report and both attempt files.

An escalation pauses only its task and the tasks that depend on it. The
other tasks go on. For how to resolve one, see [Escalations](escalations.md).

## Status file

The `STATUS.md` file of a build lists every task with its title, the tasks it
depends on, its status, its attempt count, its commit, and its last failure.
