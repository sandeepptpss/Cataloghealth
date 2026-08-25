import { redirect } from "react-router";

export const loader = async () => {
  return redirect("/app/plans");
};

export const action = async () => {
  return redirect("/app/plans");
};

export default function PricingRedirect() {
  return null;
}
