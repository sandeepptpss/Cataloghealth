import { redirect } from "react-router";

export const loader = async () => {
  return redirect("/app/logs");
};

export const action = async () => {
  return redirect("/app/logs");
};

export default function CatalogScansRedirect() {
  return null;
}
