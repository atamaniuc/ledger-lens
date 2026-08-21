import type { Preview } from "@storybook/react";
import { Providers } from "../src/components/providers";
import "../src/app/globals.css";

// The app's own provider tree, reused rather than re-declared: a story that
// runs against a different QueryClient than the page would be documenting a
// component that does not exist. `Providers` is the only wrapper the panels
// need — they get their data through props (server components) or their own
// injected fetchers (lineage, copilot).
const preview: Preview = {
  decorators: [
    (Story) => (
      <Providers>
        <div className="bg-background p-page font-sans">
          <Story />
        </div>
      </Providers>
    ),
  ],
};

export default preview;
