import * as React from "react";
import { createRef, useEffect } from "react";
import { renderMathInElement, MathfieldElement } from "mathlive";

export const MathLiveComponent = ({initialLatex, onLatexChange}: {initialLatex: string, onLatexChange: (latexValue: string) => void}) => {
    const divRef = createRef<HTMLDivElement>();
    
    useEffect(() => {
        console.log("Rendering MathLive into the the div.");
        const mfe = new MathfieldElement({
            soundsDirectory: null
        });
        mfe.value = initialLatex;
        mfe.addEventListener('input', () => {
            onLatexChange(mfe.value);
        });

        divRef.current!.innerHTML = "";
        divRef.current?.appendChild(mfe);
    }, [])

    return <div ref={divRef} />;
}
