import * as React from "react";
import { createRef, useEffect } from "react";
import { renderMathInElement, MathfieldElement } from "mathlive";

// try {
//     customElements.define('math-field1', MathfieldElement);
// }
// catch (e) {
//     console.warn('Failed to define the math-field web component.', e)
// }

export const MathLiveComponent = ({initialLatex, onLatexChange}: {initialLatex: string, onLatexChange: (latexValue: string) => void}) => {
    const divRef = createRef<HTMLDivElement>();
    
    useEffect(() => {
        console.log("Rendering MathLive into the the div.");
        const mfe = new MathfieldElement({
            soundsDirectory: null
        });
        mfe.value = initialLatex;

        divRef.current!.innerHTML = "";
        divRef.current?.appendChild(mfe);
    }, [])

    return <div ref={divRef} />;
}
