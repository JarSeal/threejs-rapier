export const PercentagePieHtml = (
  percentage: number = 0,
  opts?: {
    height?: string;
    mainClass?: string;
    fillClass?: string;
    size?: number;
    fillColor?: string;
  }
) => {
  const h = opts?.height || '1rem';
  const pieCSS = `display: inline-block; border-radius: 50%; width: ${h}; height: ${h}; position: relative; line-height: 0; font-size: ${opts?.size || '200'}%; letter-spacing: 0; overflow: hidden;`;

  const class0 = ['percentagePie'];
  if (opts?.mainClass) class0.push(opts.mainClass);
  const class1 = ['percentagePieFill'];
  if (opts?.fillClass) class1.push(opts.fillClass);

  let color = '#fff';
  if (opts?.fillColor) color = opts.fillColor;

  let per = percentage;
  if (per < 0) per = 0;
  if (per > 100) per = 100;

  // H1
  const h1Style = `display: inline-block; position: absolute; bottom: 0; left: 50%; width: 50%; height: 100%; overflow: hidden;`;
  let h1Rot = '0deg';
  if (per > 50) {
    h1Rot = '180deg';
  } else {
    h1Rot = `${(per / 50) * 180}deg`;
  }
  const h1InnerStyle = `display: inline-block; transform: rotate(${h1Rot}); position: absolute; left: -200%; top: -150%; width: 400%; height: 400%; overflow: hidden;`;
  const h1FillStyle = `display: inline-block; position: absolute; left: 0; top: 0; width: 50%; height: 100%; background: ${color}`;

  // H2
  const h2Style = `display: inline-block; position: absolute; bottom: 0; left: 0; width: 50%; height: 100%; overflow: hidden;`;
  let h2Rot = '0deg';
  if (per > 50) {
    h2Rot = `${((per - 50) / 50) * 180}deg`;
  } else {
    h2Rot = '0deg';
  }
  const h2InnerStyle = `display: inline-block; transform: rotate(${h2Rot}); position: absolute; left: -100%; top: -150%; width: 400%; height: 400%; overflow: hidden;`;
  const h2FillStyle = `display: inline-block; position: absolute; right: 0; top: 0; width: 50%; height: 100%; background: ${color};`;
  const html = `<span class="${class0}" style="${pieCSS}">
  <span class="${class1} percentagePieFillH1" style="${h1Style}">
    <span style="${h1InnerStyle}">
      <span style="${h1FillStyle}"></span>
    </span>
  </span>
  <span class="${class1} percentagePieFillH2" style="${h2Style}">
    <span style="${h2InnerStyle}">
      <span style="${h2FillStyle}"></span>
    </span>
  </span>
</span>`;
  return html;
};
