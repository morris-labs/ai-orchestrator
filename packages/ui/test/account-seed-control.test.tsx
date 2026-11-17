import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ApiClient } from "../src/api/client";
import { ApiClientProvider } from "../src/api/react";
import { AccountSeedControl } from "../src/components/AccountSeedControl";

it("warns about using copied sign-ins on the host and in accounts", () => {
  const client = new ApiClient({ baseUrl: "http://localhost", token: "synthetic" });
  render(
    <ApiClientProvider client={client}>
      <AccountSeedControl />
    </ApiClientProvider>,
  );
  expect(
    screen.getByText(
      /using a copied sign-in on both the host and an account can sign out either copy/,
    ),
  ).toHaveTextContent("Sign in separately to each account");
});
