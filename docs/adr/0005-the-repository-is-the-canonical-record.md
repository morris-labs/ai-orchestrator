# The repository is the canonical record

Status: accepted

The Scribe commits decisions, the glossary, the architecture doc, and the
codebase walkthrough to the repository in each pull request. The owner's
memory archive receives copies through a sink interface. The build plan
itself stays in the `.aio/builds/` directory, which Git ignores. This choice
means every pull request carries its own reasons, the record survives without
the archive, and the archive can live inside AI Orchestrator or stay a local
add-on.
