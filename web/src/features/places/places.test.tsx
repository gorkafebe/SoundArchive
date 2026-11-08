import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Language } from "../../i18n/i18n";
import { fakeServer, json, makePlace, mockFetch } from "../../test/fakeApi";
import { Providers } from "../../test/providers";
import { PlaceList } from "./PlaceList";
import { PlaceSheet } from "./PlaceSheet";

function wrap(children: ReactNode, language: Language = "es") {
  return <Providers language={language}>{children}</Providers>;
}

afterEach(() => vi.unstubAllGlobals());

describe("PlaceList", () => {
  const places = Array.from({ length: 45 }, (_, i) => makePlace(i + 1));

  function renderList(props: Partial<Parameters<typeof PlaceList>[0]> = {}) {
    const onQueryChange = vi.fn();
    const onSelect = vi.fn();
    const utils = render(
      wrap(
        <PlaceList
          query=""
          page={1}
          onQueryChange={onQueryChange}
          selectedId={null}
          onSelect={onSelect}
          reloadKey={0}
          {...props}
        />,
      ),
    );
    return { ...utils, onQueryChange, onSelect };
  }

  it("shows a page of places with a total and page navigation", async () => {
    fakeServer(places);
    renderList();

    expect(await screen.findByText("45 lugares")).toBeInTheDocument();
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("button")).toHaveLength(20);
    expect(screen.getByText("Página 1 de 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Página anterior" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Página siguiente" })).toBeEnabled();
  });

  it("asks for the next page", async () => {
    fakeServer(places);
    const { onQueryChange } = renderList();
    await userEvent.click(await screen.findByRole("button", { name: "Página siguiente" }));
    expect(onQueryChange).toHaveBeenCalledWith("", 2);
  });

  it("requests the right offset for page 3", async () => {
    const fetch = fakeServer(places);
    renderList({ page: 3 });
    expect(await screen.findByText("Página 3 de 3")).toBeInTheDocument();
    const listCall = fetch.mock.calls.map(([u]) => String(u)).find((u) => u.includes("/list"));
    expect(listCall).toContain("offset=40");
    expect(within(screen.getByRole("list")).getAllByRole("button")).toHaveLength(5);
  });

  it("submits a trimmed search from a labelled field", async () => {
    fakeServer(places);
    const { onQueryChange } = renderList();
    await userEvent.type(screen.getByRole("searchbox", { name: "Buscar lugares" }), "  place 4  {Enter}");
    expect(onQueryChange).toHaveBeenCalledWith("place 4", 1);
  });

  it("says when nothing matches", async () => {
    fakeServer(places);
    renderList({ query: "zzz" });
    expect(await screen.findByText("Ningún lugar coincide con «zzz».")).toBeInTheDocument();
  });

  it("opens a place with the keyboard", async () => {
    fakeServer(places);
    const { onSelect } = renderList();
    const first = await screen.findByRole("button", { name: /Place 1 Description 1/ });
    first.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(places[0].id);
  });

  it("shows an error with a retry button", async () => {
    let fail = true;
    mockFetch(() => (fail ? json({}, 500) : json({ items: [], total: 0, limit: 20, offset: 0 })));
    renderList();
    expect(await screen.findByText("No se pudo cargar la lista.")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByText("Todavía no hay lugares.")).toBeInTheDocument();
  });
});

describe("PlaceSheet", () => {
  const place = makePlace(1, { name: "Old market", description: "Rain on a tin roof", latitude: 43.263, longitude: -2.935 });

  it("loads the place, moves the focus to its name and shows the empty recordings space", async () => {
    fakeServer([place]);
    render(wrap(<PlaceSheet placeId={place.id} onClose={() => {}} />));

    const heading = await screen.findByRole("heading", { level: 2, name: "Old market" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText("Rain on a tin roof")).toBeInTheDocument();
    expect(screen.getByText("43,26300° N, 2,93500° O")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Grabaciones/ })).toBeInTheDocument();
    expect(await screen.findByText("Aún no hay grabaciones aquí")).toBeInTheDocument();
    // A complementary region (non-modal), not a dialog.
    expect(screen.getByRole("complementary", { name: "Ficha del lugar" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses English texts and coordinates in English", async () => {
    fakeServer([place]);
    render(wrap(<PlaceSheet placeId={place.id} onClose={() => {}} />, "en"));
    expect(await screen.findByText("43.26300° N, 2.93500° W")).toBeInTheDocument();
    expect(await screen.findByText("No recordings here yet")).toBeInTheDocument();
  });

  it("closes", async () => {
    fakeServer([place]);
    const onClose = vi.fn();
    render(wrap(<PlaceSheet placeId={place.id} onClose={onClose} />));
    await userEvent.click(await screen.findByRole("button", { name: "Cerrar" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes with Escape", async () => {
    fakeServer([place]);
    const onClose = vi.fn();
    render(wrap(<PlaceSheet placeId={place.id} onClose={onClose} />));
    const heading = await screen.findByRole("heading", { level: 2, name: "Old market" });
    await waitFor(() => expect(heading).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("says when the place does not exist", async () => {
    fakeServer([]);
    render(wrap(<PlaceSheet placeId={place.id} onClose={() => {}} />));
    expect(await screen.findByText("Este lugar no existe o se ha borrado.")).toBeInTheDocument();
  });

  it("on a phone, the handle changes the height with a press and the arrow keys", async () => {
    fakeServer([place]);
    render(wrap(<PlaceSheet placeId={place.id} onClose={() => {}} />));
    const handle = await screen.findByRole("button", { name: /Altura del panel: media/ });
    await userEvent.click(handle);
    expect(handle).toHaveAccessibleName(/Altura del panel: completa/);
    handle.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(handle).toHaveAccessibleName(/Altura del panel: pequeña/);
  });
});
