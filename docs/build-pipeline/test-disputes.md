# Test disputes

A Developer that believes a locked test is wrong sends a test dispute. The
dispute goes to the Test engineer, not to the Project manager, and it
doesn't count as a gate attempt. This page describes how the engine settles
a dispute. For the test lock itself, see the tests first section of the
[build pipeline design](design.md).

## Send a dispute

The Developer leaves the locked test as it is and puts the dispute in the
`dispute` field of its report:

```json
{
  "summary": "Added the cart total.",
  "criteria": [{ "id": "AC1", "met": true }],
  "dispute": {
    "test": "test/cart.test.mjs",
    "reason": "AC1 asks for the sum of the prices, but the test wants double."
  }
}
```

For an answer with a dispute, the engine skips the task gate and keeps the
task's attempt count. Once the dispute is settled, the same attempt runs
again with a call of its own, and its context says how the dispute ended.

A dispute about a file that the lock doesn't hold, or in a build without a
test lock, ends rejected without a call to the Test engineer.

## How a dispute ends

| Outcome | When | What happens |
| :--- | :--- | :--- |
| Amended | The Test engineer fixes the test and answers `amend`. | The engine runs the red check on the fixed test, then commits it, locks it again, and records the amendment. |
| Rejected | The Test engineer answers `reject`, or its fix fails the red check. | The test stands as it is locked, and the Developer gets the reason. |
| Ruled on | A second dispute about one test, or a third dispute in one task. | The engine raises a `test_dispute` escalation for the Project manager, and the task waits. |
| Escalated | The Test engineer's fix changes what a criterion means. | The engine saves the fix as a patch, keeps the locked test, and raises a `test_dispute` escalation for the owner. |

### The Test engineer's turn

The Test engineer gets the disputed file as its only owned file, the
Developer's reason, and the criteria of the file's tests. It answers with
this object:

- **`verdict`:** `amend` or `reject`.
- **`reason`:** why, which the Developer reads.
- **`changesCriterion`:** `true` when the fix changes what a criterion
  means.
- **`tests`:** optional. With `amend`, every test in the file, when the
  names or commands changed.

Before the turn, the engine puts back any change that the Developer made to
a locked test and commits the task's work. After the turn, it puts back any
file that the Test engineer changed other than the disputed test.

### The red check of an amendment

The engine runs the red check on the fixed test against the code as it was
before the task: it puts the task's other changes back to the task's base
for the run, then restores them. Each test must fail on an assertion, as in
tests first. A fix that fails the red check isn't locked, and the dispute
ends rejected.

### The amendment record

An amended test changes the `test-lock.json` file in the build directory:
the file's hash, its tests, the lock's commit, and a new entry in
`amendments`:

- **`dispute`:** the dispute file, such as `tasks/T1/dispute-1.json`.
- **`taskId`:** the task whose Developer disputed the test.
- **`test`:** the test file.
- **`reason`:** the Test engineer's reason.
- **`commit`:** the commit that holds the fixed test.
- **`at`:** when the engine locked it.

The task gate's permission check doesn't count a test that a dispute of the
same task amended as the Developer's change.

## Resolve a dispute escalation

- **Ruled on:** resolve with `clarify` and a note, which the Developer's next
  try reads, or with `retry` to keep the test as it is locked.
- **Escalated:** the owner resolves with `changes` that include `criteria`
  to accept the fix. The engine then applies the saved patch, runs the red
  check, and locks the fix. A resolution without `criteria` keeps the locked
  test.

For example, to accept a fix that changes a criterion, run this command,
where `BUILD` is the build's slug and `ESCALATION` is the escalation's ID:

```bash
aio-build resolve BUILD ESCALATION retry --owner --changes criteria --note "AC1 means the plain sum."

```

## Files

Each dispute saves `tasks/TASK/dispute-N.json` in the build directory as it
goes: the claim, the Test engineer's answer, the red check, and the outcome.
A restarted build continues from the last finished part. An escalated fix
waits in `tasks/TASK/dispute-N.patch`.
