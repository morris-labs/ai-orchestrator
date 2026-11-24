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

## Per-test commands

The Test engineer lists each test with a command that runs that test alone,
and the test lock keeps those commands. The plan's own test commands can
start with `NAME=value` assignments that set up the environment the tests
need. For example, `PATH=/usr/bin:$PATH corepack pnpm -r test` picks the
system Node.js that the native modules were built for.

The engine runs every per-test command in that same environment. Before it
runs one, it puts the leading assignments of the plan's test commands in
front of it. When two test commands assign the same name, the first one's
value counts, and a name that the per-test command assigns itself keeps the
per-test command's value. An assignment counts only when a command follows
it, so `A=1; make test` and `A=1 && make test` set nothing. A command that
starts with `env` sets nothing either.

The plan's setup commands get the same assignments, so a dependency
install at preflight builds native modules for the Node.js that the tests
use. A setup command keeps its own `cwd`.

The engine also runs a per-test command in the plan's test directory when
every plan test command sets the same `cwd`. When the plan's test commands
set different directories, or one of them sets none, the per-test command
runs from the repository root. The Test engineer is told to write its
commands from the repository root, so the root is the only directory that
fits every test when the plan has no single test directory.

A per-test command that exits 0 but runs no tests fails, such as a name
filter that no longer matches. A run of no tests proves nothing, so it
doesn't count as a pass in the task gate or in the criteria trace. The
gate reports such a command as one that ran no tests.

The `runListedTest()` function in the
`packages/engine/src/build/test-command.ts` file builds and runs the
command. Every place that runs a per-test command uses it, or, in the task
gate, the `listedTestCommand()` and `requireTests()` functions it is made
of:

- The red check of tests first.
- The red check of a test dispute's amended test.
- The task gate's run of an earlier task's locked tests.
- The criteria trace of the release ready step.

The Test engineer's task description names the assignments and the
directory, so that it runs its tests the same way, writes each command for
that directory, and lists each command without the assignments.

### What counts as red

The red check proves that each test fails for the right reason: on an
assertion. It reads a run as an error, not as red, when the output shows
either of the following:

- The test file failed to load or collect, such as a syntax error, a missing
  module, a native module built for another Node.js version
  (`NODE_MODULE_VERSION`), or a suite that the runner couldn't collect.
- The command ran no tests, such as a name filter that matched nothing or a
  file with no tests. This holds whatever the exit code, since some runners
  exit 0 when every test is filtered out.

The `classifyRun()` function in the `packages/engine/src/build/red-check.ts`
file holds the patterns, for the common JavaScript, TypeScript, Python, and
Go test runners. A test that errors goes back to the Test engineer.

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
